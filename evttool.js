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
 * evttool
 *
 */

var path = require('path');

// GLOBALS
var openEvents = {};

/*
 * Call line_cb(line) for each line in stdin,
 * then call callback([err]) on EOF or error.
 */
function forEachLine(line_cb, callback)
{
    var buffer = '';
    var chunks;

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
     * Unfortunately usage here is inconsistent. Do what we can.
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

    // Remove some fields we don't care about any more for analysis
    delete evt.className;
    delete evt.label;
    delete evt.pid;
    delete evt.stack;

    return (evt);
}

function evtSig(evt) {
    return (evt.req_id + ':' + evt.hostname + ':' + evt.id);
}

function handleBegin(evt) {
    var sig = evtSig(evt);

    if (openEvents[sig]) {
        console.error('WARN: got begin twice without end: '
            + JSON.stringify(evt));
        return;
    }

    console.log(JSON.stringify(evt));

    // We only need to know start time and signature, then when we
    // see an end with the same sigature, we know that has completed.
    openEvents[sig] = evt.time;
}

function handleEnd(evt) {
    var sig = evtSig(evt);

    if (!openEvents[sig]) {
        // ignore ends without beginnings!
        return;
    }

    evt.elapsed = evt.time - openEvents[sig];

    console.log(JSON.stringify(evt));

    // no longer open
    delete openEvents[sig];
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

function main() {
    process.stdin.resume();

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
        // DONE!
    });
}

// Kick everything off
main();
