#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2015, Joyent, Inc.
 *
 * Usage:
 *
 * evttool [options]
 *
 * -h
 * -e REGEX     show only events w/ top-level id that matches REGEX
 * -r           show report at end of input
 * -s           show events as encountered (stream)
 * --no-color   disable colors in output
 *
 * Examples:
 *
 * # Show events as they are encountered on stdin
 *
 *     cat <logs> | ./evttool.js -s
 *
 * # Show 1 line per event for events that took longer than 100ms
 *
 *     cat <logs> | ./evttool.js -s -t 100
 *
 * # Show a report of all docker.* events that took more than 100ms
 *
 *     cat <logs> | /evttool.js -r -e '^docker\.' -t 100
 */

var dashdash = require('dashdash');
var path = require('path');

// GLOBALS
var ignoredIds = {};
var stylize = stylizeWithColor;
var openEvents = {};
var options;
var cmdline_opts;
var parser;
var requestEvents = {};

// define the options
options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        names: ['debug', 'd'],
        type: 'bool',
        help: 'Output debug info'
    },
    {
        names: ['events', 'e'],
        type: 'string',
        help: 'Filter by type of events',
        helpArg: 'EVENT'
    },
    {
        names: ['report', 'r'],
        type: 'bool',
        help: 'Output a report once all data is read'
    },
    {
        names: ['stream', 's'],
        type: 'bool',
        help: 'Output events in a short "stream" format'
    },
    {
        names: ['time', 't'],
        type: 'positiveInteger',
        help: 'Show only events that took longer than MS milliseconds',
        helpArg: 'MS'
    },
    {
        names: ['no-color'],
        type: 'bool',
        help: 'Disable all colors'
    }
];

/*
 * Call line_cb(line) for each line in stdin,
 * then call callback([err]) on EOF or error.
 */
function forEachLine(line_cb, callback)
{
    var buffer = '';
    var chunks;

    process.stdin.resume();

    process.stdin.on('end', function () {
        // remainder
        line_cb(buffer);
        callback();
    });

    process.stdin.on('data', function (data) {
        var chunk;

        buffer += data.toString();
        chunks = buffer.split('\n');
        while (chunks.length > 1) {
            chunk = chunks.shift();
            line_cb(chunk);
        }
        buffer = chunks.pop();
    });
}

/*
 * Returns: true if 'str' is a UUID, false otherwise.
 */
function isUUID(str)
{
    var re = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (str && str.length === 36 && str.match(re)) {
        return true;
    } else {
        return false;
    }
}

/*
 * Normalize the bunyan message into an Event object with:
 *
 * evt.id:       Something like machine_create.create.create-zone-uuid
 * evt.req_id:   The UUID of the request this event belongs to
 * evt.time:     The timestamp of the event (ms since Unix Epoch)
 * evt.phase:    One of: 'begin' or 'end'
 * evt.hostname: The hostname of the zone/CN where this event occurred
 *
 */
function objToEvent(obj)
{
    var evt = {};
    var id;

    if (!obj.evt || !obj.req_id || ['b', 'e'].indexOf(obj.evt.ph) === -1) {
        return (null);
    }

    // keep only the fields we use
    evt.className = path.basename(obj.name); // eg. machine_create, vmapi, etc
    evt.hostname = obj.hostname;
    evt.label = obj.evt.name;
    evt.pid = obj.pid;
    evt.stack = obj.stack;
    evt.time = (new Date(obj.time)).getTime();
    evt.phase = (obj.evt.ph === 'b') ? 'begin' : 'end';
    evt.req_id = obj.req_id;

    /*
     * Unfortunately usage here is inconsistent. Try to make it moreso.
     */
    if (evt.stack) {
        id = evt.stack;
    } else if (evt.className === evt.label) {
        id = evt.className;
    } else if (evt.label.indexOf(evt.className) === 0) {
        id = evt.label;
    } else {
        id = evt.className + '.' + evt.label;
    }
    evt.id = id;

    // Remove some fields we don't care about for now
    delete evt.className;
    delete evt.label;
    delete evt.pid;
    delete evt.stack;

    return (evt);
}


//
// Color handling stolen from node-bunyan
//

// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Suggested colors (some are unreadable in common cases):
// - Good: cyan, yellow (limited use), grey, bold, green, magenta, red
// - Bad: blue (not visible on cmd.exe)
var colors = {
    'bold' : [1, 22],
    'italic' : [3, 23],
    'underline' : [4, 24],
    'inverse' : [7, 27],
    'white' : [37, 39],
    'grey' : [90, 39],
    'black' : [30, 39],
    'blue' : [34, 39],
    'cyan' : [36, 39],
    'green' : [32, 39],
    'magenta' : [35, 39],
    'red' : [31, 39],
    'yellow' : [33, 39]
};

function stylizeWithColor(str, color) {
    var codes = colors[color];

    if (!str) {
        return ('');
    }
    if (codes) {
        return ('\033[' + codes[0] + 'm' + str + '\033[' + codes[1] + 'm');
    } else {
        return (str);
    }
}

function stylizeWithoutColor(str, color) {
    return (str);
}

/*
 * fitTo(str, len, [opts]) is used to pad a string to a length.
 *
 * Without opts, it will truncate str to len if longer and pad with spaces on
 * the left if shorter.
 *
 * With the opts.dir set to 'right', padding (if required) will be placed on the
 * right end of the string instead of the left.
 *
 * With the opts.trunc set to false, the value will not be truncated if it is
 * longer than len.
 *
 * The return is always a string.
 *
 */
function fitTo(str, len, opts)
{
    var dir = ((opts && opts.dir) ? opts.dir : 'left');
    var trunc = ((opts && opts.trunc === false) ? opts.trunc : true);

    if (typeof (str) !== 'string') {
        str = str.toString();
    }

    if (str.length > len && trunc) {
        return (str.slice(0, len));
    }

    while (str.length < len) {
        if (dir && dir === 'right') {
            str = ' ' + str;
        } else {
            str = str + ' ';
        }
    }
    return (str);
}

/*
 * Show the *time* only, no date.
 */
function shortTime(time) {
    return (new Date(time).toISOString().split(/[TZ]/)[1]);
}

function shortFmt(evt, opts) {
    var action_prefix = (opts ? opts.prefix : null);
    var evt_id = evt.id;
    var hostname = evt.hostname;
    var req_id = evt.req_id;
    var time = shortTime(evt.time);

    if (isUUID(hostname)) {
        hostname = hostname.split('-')[0];
    }
    hostname = fitTo(hostname, 8);

    if (evt.phase === 'end' && evt.elapsed) {
        if (opts && opts.start_plus) {
            time = time + fitTo(' +' + evt.elapsed, 8,
                {dir: 'right', trunc: false});
        } else {
            time = fitTo('+' + evt.elapsed, 12,
                {dir: 'right', trunc: false});
        }
    }

    if (action_prefix === null) {
        if (evt.phase === 'begin') {
            action_prefix = '-->';
        } else {
            action_prefix = '<--';
        }
    }

    return (action_prefix + ' ' + time + ' [' + req_id + '] -- ' + hostname
        + ' -- ' + evt_id);
}

function evtSig(evt) {
    return (evt.req_id + ':' + evt.hostname + ':' + evt.id);
}

function reportProcessRequest(req_id, events, data) {
    var datapoints;
    var first;
    var sorted;

    sorted = events.sort(function _eventSorter(a, b) {
        return (a.start - b.start);
    });

    first = sorted[0];

    // XXX this assumes a synchronous request at the top level and all other
    // bits for the req_id happen in between.

    // if we've got a time filter, remove those that are too fast
    if (cmdline_opts.time && first.elapsed < cmdline_opts.time) {
        return;
    }

    if (cmdline_opts.events && !first.id.match(cmdline_opts.events)) {
        // console.log('SKIPPING: ' + first.id + ' due to --events');
        return;
    }

    // Eg. docker.containercreate
    if (!data.hasOwnProperty(first.id)) {
        data[first.id] = { events: {} };
    }

    // Sum the datapoints for this record
    datapoints = {};
    sorted.forEach(function _recordOne(evt) {
        if (!datapoints[evt.id]) {
            datapoints[evt.id] = {};
        }
        // datapoints[evt.id].count = (!datapoints[evt.id].count
        //    ? 1 : (datapoints[evt.id].count + 1));
        datapoints[evt.id].total = (!datapoints[evt.id].total
            ? evt.elapsed : (datapoints[evt.id].total + evt.elapsed));
    });

    // Any datapoints we want to merge into data, do so now
    Object.keys(datapoints).forEach(function (k) {
        if (!data[first.id].events.hasOwnProperty(k)) {
            data[first.id].events[k] = {
                // counts: [],
                values: []
            };
        }
        // data[first.id].events[k].counts.push(datapoints[k].count);
        data[first.id].events[k].values.push(datapoints[k].total);
    });
}

function outputReport() {
    var data = {};

    Object.keys(requestEvents).forEach(function _requestEvent(k) {
        reportProcessRequest(k, requestEvents[k], data);
    });

    console.log(JSON.stringify(data, null, 2));
}

function handleBegin(evt) {
    var sig = evtSig(evt);

    if (openEvents[sig]) {
        console.error('WARN: got begin twice without end: '
            + JSON.stringify(evt));
        return;
    }

    // We only need to know start time and signature, then when we
    // see an end with the same sigature, we know that has completed.
    openEvents[sig] = evt.time;

    if (cmdline_opts.time) {
        // we never output anything on 'begin' when --time is set because we
        // can't know how long something took until we see the end.
        return;
    }

    // Output depending on options

    if (cmdline_opts.stream) {
        console.log(shortFmt(evt));
    } else if (!cmdline_opts.report) {
        console.log(JSON.stringify(evt));
    }
}

function handleEnd(evt) {
    var sig = evtSig(evt);
    var start;

    if (!openEvents[sig]) {
        // ignore ends without beginnings!
        return;
    }

    start = openEvents[sig];
    evt.elapsed = evt.time - start;

    // no longer open
    delete openEvents[sig];

    // add this (now closed) event to the list for this req_id
    if (!requestEvents[evt.req_id]) {
        requestEvents[evt.req_id] = [];
    }
    requestEvents[evt.req_id].push({
        elapsed: evt.elapsed,
        hostname: evt.hostname,
        id: evt.id,
        start: start
    });

    if (cmdline_opts.time && evt.elapsed < cmdline_opts.time) {
        // If --time is set and this time was too short, we're not going to
        // output this line now.
        return;
    }

    // Output

    if (cmdline_opts.stream) {
        if (!cmdline_opts.time) {
            console.log(shortFmt(evt));
        } else if (evt.elapsed >= cmdline_opts.time) {
            console.log(shortFmt(evt, {prefix: '', start_plus: true}));
        }
    } else if (!cmdline_opts.report) {
        console.log(JSON.stringify(evt));
    }
}

function handleEvent(evt) {
    switch (evt.phase) {
        case 'end':
            handleEnd(evt);
            break;
        case 'begin':
            handleBegin(evt);
            break;
        default:
            throw new Error('Unhandled phase: ' + evt.phase);
    }
}

function dumpHelp()
{
    var help;

    help = parser.help({includeEnv: true}).trimRight();
    console.log('\nusage: evttool [OPTIONS]\n'
        + 'options:\n' + help + '\n');
}

function main() {
    // parse the cmdline
    parser = dashdash.createParser({options: options});
    try {
        cmdline_opts = parser.parse(process.argv);
    } catch (e) {
        console.error('evttool: error: %s', e.message);
        process.exit(1);
    }

    if (cmdline_opts.help || cmdline_opts._args.length > 0) {
        dumpHelp();
        process.exit(0);
    }

    if (!process.stderr.isTTY || cmdline_opts['no-color']) {
        stylize = stylizeWithoutColor;
    }

    forEachLine(function (line) {
        var evt;

        if (line.length === 0) {
            return;
        }

        evt = objToEvent(JSON.parse(line));
        handleEvent(evt);
    }, function (err, evts) {
        if (err) {
            console.error('ERROR: ' + err.message);
            return;
        }
        if (cmdline_opts.report) {
            outputReport();
        }
        if (cmdline_opts.debug) {
            console.error('=== Ignored Events ===');
            console.error(JSON.stringify(ignoredIds, null, 2));
        }
    });
}

// Kick everything off
main();
