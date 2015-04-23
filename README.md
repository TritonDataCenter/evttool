## What is this?

If you don't know, this is not the repo you're looking for.

## Installation

```
npm install
```

## Examples

### Note about examples

The examples here assume you have a set of evt log files. If you don't know
where to get such data files, this won't be of much help to you.

### Find req_id of slow docker createcontainer's

```
gzcat ~/logs/events.20150422.log.gz | ./evttool.js -t 10000 | grep 'docker.containercreate' | json -ag elapsed req_id | sort -n
```

### Generate a report of all the docker.containercreate jobs and sub-tasks

```
gzcat ~/logs/events.20150422.log.gz | ./evttool.js -r -e '^docker\.containercreate'
```

### Generate a timeline of a given req_id

```
gzcat ~/logs/events.20150422.log.gz | ./evttool.js --timeline 8a131482-c1a7-4d50-bd15-38c50163dd86
```

