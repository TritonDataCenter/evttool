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
 * -t TIME      show only events that took more than TIME ms
 * -T REQ_ID    show a timeline of events for REQ_ID
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
var insaneReqs = {};
var ignoredIds = {};
var lateReqs = {};
var stylize = stylizeWithColor;
var openEvents = {};
var options;
var cmdline_opts;
var parser;
var requestEvents = {};
var warnings = [];

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
        names: ['timeline', 'T'],
        type: 'string',
        help: 'Show a timeline view of a specific request',
        helpArg: 'REQ_ID'
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

    // req_time/req_seq can be used to differentiate requests that would
    // otherwise be identical, we hide it from output/aggregations but include
    // in the id.
    if (obj.evt.req_time) {
        evt.id = evt.id + '.' + obj.evt.req_time;
    } else if (obj.evt.req_seq) {
        evt.id = evt.id + '.' + obj.evt.req_seq;
    }

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

function trimIdSeq(id) {
    // imgapi.getimage.1429078896344 -> imgapi.getimage
    return (id.replace(/\.[0-9]+$/, ''));
}

function shortFmt(evt, opts) {
    var action_prefix = (opts ? opts.prefix : null);
    var evt_id = trimIdSeq(evt.id);
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
    var expected_finish;
    var first;
    var first_id;
    var sorted;

    sorted = events.sort(function _eventSorter(a, b) {
        return (a.start - b.start);
    });

    first = sorted[0];
    first_id = trimIdSeq(first.id);

    // XXX this assumes a synchronous request at the top level and all other
    // bits for the req_id happen in between.

    // if we've got a time filter, remove those that are too fast
    if (cmdline_opts.time && first.elapsed < cmdline_opts.time) {
        return;
    }

    if (cmdline_opts.events && !first_id.match(cmdline_opts.events)) {
        // console.log('SKIPPING: ' + first_id + ' due to --events');
        return;
    }

    expected_finish = first.start + first.elapsed;

    // Eg. docker.containercreate
    if (!data.hasOwnProperty(first_id)) {
        data[first_id] = {
            count: 0,
            events: {},
            max: 0,
            min: 0
        };
    }
    data[first_id].count++;
    if (data[first_id].min === 0 || first.elapsed < data[first_id].min) {
        data[first_id].min = first.elapsed;
    }
    if (data[first_id].max === 0 || first.elapsed > data[first_id].max) {
        data[first_id].max = first.elapsed;
    }

    // Sum the datapoints for this record
    datapoints = {};
    sorted.forEach(function _recordOne(evt) {
        var id = trimIdSeq(evt.id);

        if (!datapoints[id]) {
            datapoints[id] = {};
        }
        datapoints[id].count = (!datapoints[id].count
            ? 1 : (datapoints[id].count + 1));
        datapoints[id].total = (!datapoints[id].total
            ? evt.elapsed : (datapoints[id].total + evt.elapsed));

        // Any req_id with more than 100 runs of the same task seems like a
        // problem
        if (datapoints[id].count > 100) {
            if (!insaneReqs.hasOwnProperty(req_id)) {
                insaneReqs[req_id] = {};
            }
            insaneReqs[req_id][id] = datapoints[id].count;
        }
        if (evt.start > expected_finish) {
            if (!lateReqs.hasOwnProperty(req_id)) {
                lateReqs[req_id] = {};
            }
            lateReqs[req_id][id] =
                (!lateReqs[req_id][id] ? 1 : lateReqs[req_id][id] + 1);
        }
    });

    // Any datapoints we want to merge into data, do so now
    Object.keys(datapoints).forEach(function (k) {
        if (!data[first_id].events.hasOwnProperty(k)) {
            data[first_id].events[k] = {
                // counts: [],
                max: 0,
                min: 0,
                sum: 0,
                values: []
            };
        }
        // data[first_id].events[k].counts.push(datapoints[k].count);
        data[first_id].events[k].values.push(datapoints[k].total);
        data[first_id].events[k].sum += datapoints[k].total;
        if (data[first_id].events[k].max === 0
            || datapoints[k].total > data[first_id].events[k].max) {

            data[first_id].events[k].max = datapoints[k].total;
        }
        if (data[first_id].events[k].min === 0
            || datapoints[k].total < data[first_id].events[k].min) {

            data[first_id].events[k].min = datapoints[k].total;
        }
    });
}

function filler(character, count) {
    var i;
    var retstr = '';

    for (i = 0; i < count; i++) {
        retstr += character;
    }

    return (retstr);
}

function powerOfTwoBuckets(data) {
    var buckets = {max_count: 0};
    var max;
    var min;

    data.forEach(function (d) {
        var bucket = 0;
        var bucket_value;

        while (d >= Math.pow(2, bucket)) {
            bucket++;
        }
        bucket_value = Math.pow(2, bucket);

        if (min === undefined || bucket_value < min) {
            min = bucket_value;
        }
        if (max === undefined || bucket_value > max) {
            max = bucket_value;
        }

        if (!buckets[bucket_value]) {
            buckets[bucket_value] = 0;
        }
        buckets[bucket_value]++;
        if (buckets[bucket_value] > buckets.max_count) {
            buckets.max_count = buckets[bucket_value];
        }
    });

    for (var i = (min / 2); i <= (max * 2); i = i * 2) {
        if (i > 0) {
            if (!buckets.hasOwnProperty(i)) {
                buckets[i] = 0;
            }
        }
    }

    return (buckets);
}

function outputReport() {
    var count = 0;
    var data = {};

    // Add data from all requests to "data"
    Object.keys(requestEvents).forEach(function _requestEvent(k) {
        reportProcessRequest(k, requestEvents[k], data);
    });

    Object.keys(data).forEach(function (id) {
        if (count > 0) {
            console.log('');
        }
        count++;
        console.log(id + ' (count: ' + data[id].count + ', min: ' + data[id].min
            + ', max: ' + data[id].max + ')\n  \\');
        Object.keys(data[id].events).sort(function (a, b) {
            return (data[id].events[b].max - data[id].events[a].max);
        }).forEach(function (_event) {
            var evt = data[id].events[_event];
            var median_idx = Math.floor((evt.values.length + 1) / 2);

            if (cmdline_opts.time && evt.max < cmdline_opts.time) {
                // the slowest one here was too fast for us to care about, skip.
                return;
            }

            evt.mean = Math.floor((evt.sum / evt.values.length) * 100) / 100;
            evt.median = evt.values.sort()[median_idx];
            evt.buckets = powerOfTwoBuckets(evt.values);

            console.log('   ' + _event
                + ' (min: ' + evt.min
                + ', max: ' + evt.max
                + ', mean: ' + evt.mean
                + ', median: ' + evt.median + ')');
            console.log('      value  ----------------------- '
                + 'Distribution ----------------------- count');
            Object.keys(evt.buckets).sort(function (a, b) {
                if (a === 'max_count') {
                    a = 0;
                }
                if (b === 'max_count') {
                    b = 0;
                }
                return (Number(a) - Number(b));
            }).forEach(function (b) {
                var hist;

                if (b === 'max_count') {
                    return;
                }

                hist = filler('#',
                    Math.round(60 * evt.buckets[b] / evt.values.length));

                console.log(filler(' ', 11 - b.toString().length) + b + '| '
                    + hist + filler(' ', 61 - hist.length) + evt.buckets[b]);
            });
        });
    });
}

function outputTimeline() {
    var ends = [];
    var level = 0;
    var first_start = 0;
    var seen_starts = {};
    var sorted;

    if (!requestEvents.hasOwnProperty(cmdline_opts.timeline)) {
        console.error('ERROR: No events for req_id: ' + cmdline_opts.timeline + ' found');
        return;
    }

    sorted = requestEvents[cmdline_opts.timeline].sort(function (a, b) {
        if (a.start === b.start) {
            return (a.id.length - b.id.length);
        }
        return (a.start - b.start);
    });

    function printEnd(evt) {
        var prefix = '';

        if (ends.length > 0) {
            prefix = fitTo('+' + (evt.time - first_start).toString(), 13, {dir: 'right'});
        } else {
            prefix = evt.time.toString();
        }

        console.log(prefix + ' (' + fitTo(evt.elapsed + ')', 7) + filler(' ', evt.level * 4)
            + 'END   ' + evt.id + evt.suffix);
    }

    function printStart(evt) {
        var prefix = '';

        if (first_start === 0) {
            first_start = evt.start;
            prefix = evt.start.toString();
        } else {
            prefix = fitTo('+' + (evt.start - first_start).toString(), 13, {dir: 'right'});
        }

        console.log(prefix + ' ' + filler(' ', (level * 4) + 7)
            + ' START ' + evt.id + evt.suffix);

    }

    console.log('(all times are in milliseconds)');
    console.log('REQ_ID: ' + cmdline_opts.timeline + '\n');
    sorted.forEach(function (evt) {
        var printme = [];

        ends = ends.filter(function (e) {
            if (evt.start >= e.time) {
                level--;
                printme.push(e);
                return (false);
            }
            return (true);
        });

        // Output the ENDs that we just removed
        printme.sort(function (a, b) {
            if (a.time === b.time) {
                return (b.id.length - a.id.length);
            }
            return (a.time - b.time);
        }).forEach(printEnd);

        if (seen_starts.hasOwnProperty(evt.id)) {
            seen_starts[evt.id]++;
            evt.suffix = ' [' + seen_starts[evt.id] + ']';
        } else {
            seen_starts[evt.id] = 0;
            evt.suffix = '';
        }

        ends.push({
            time: evt.start + evt.elapsed,
            id: evt.id,
            elapsed: evt.elapsed,
            level: level,
            suffix: evt.suffix
        });

        printStart(evt);
        level++;
    });

    while (ends.length > 0) {
        evt = ends.pop();
        level--;
        printEnd(evt);
    }
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
    } else if (!cmdline_opts.report && !cmdline_opts.timeline) {
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
        id: trimIdSeq(evt.id),
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
    } else if (!cmdline_opts.report && !cmdline_opts.timeline) {
        console.log(JSON.stringify(evt));
    }
}

function handleEvent(evt) {
    if (!evt) {
        return;
    }

    if (cmdline_opts.timeline && (evt.req_id != cmdline_opts.timeline)) {
        // When we're doing a timeline we only care about the one req
        return;
    }

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

    if (cmdline_opts.timeline && (cmdline_opts.report || cmdline_opts.stream)) {
        console.error('evttool: cannot combine --timeline and --report or --stream');
        dumpHelp();
        process.exit(1);
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
        if (cmdline_opts.timeline) {
            outputTimeline();
        }
        if (cmdline_opts.report) {
            outputReport();
        }
        if (Object.keys(insaneReqs).length > 0) {
            console.log('\n=== Insane Requests ===');
            console.log(JSON.stringify(insaneReqs, null, 2));
        }
        if (Object.keys(lateReqs).length > 0) {
            console.log('\n=== Late Requests ===');
            console.log(JSON.stringify(lateReqs, null, 2));
        }
        if (cmdline_opts.debug && Object.keys(ignoredIds).length > 0) {
            console.error('\n=== Ignored Events ===');
            console.error(JSON.stringify(ignoredIds, null, 2));
        }
    });
}

// Kick everything off
main();
