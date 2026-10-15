# Runner telemetry

GitHub reports no CPU, memory, disk or network figures for hosted runners. `actions/runner-telemetry` measures
them on the runner itself and hands one line to the ghcaretaker collector. Contract:
`infra-root/docs/adr/0001-pipeline-surround.md` section 3.

## Use

Make it the **first step** of every job you want measured. Its post step then runs last, so the figures cover the
whole job and its line is the last one in the log. Pin a reviewed full commit SHA of `workflow_depot`.

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: susanbeasles/workflow_depot/actions/runner-telemetry@REVIEWED_FULL_COMMIT_SHA
      # optional: with: { interval-seconds: 5 }
      - uses: actions/checkout@<sha>
      # ... the job's own steps
```

It needs no permissions, secrets or network access, and it never fails the job: both the main and the post step
catch every error, print at most a notice, and exit 0. A job without telemetry is a complete job.

| Input | Default | Meaning |
|---|---|---|
| `interval-seconds` | `5` | Seconds between samples, 1 to 60. Anything else falls back to 5 with a notice. |

## What it does

1. **main** (`start.mjs`, Linux only) starts a detached `node sampler.mjs` that appends one JSON line of raw
   counters to `$RUNNER_TEMP/runner-telemetry/samples.jsonl` every interval and stops writing after 20,000 samples
   (about 6 MiB). On other operating systems it prints a notice and does nothing else.
2. **post** (`stop.mjs`) stops the sampler (only if `/proc/<pid>/cmdline` is still the sampler), takes a final sample,
   aggregates, appends a table to `$GITHUB_STEP_SUMMARY`, deletes the sample file and prints exactly one line:

```
##[runner-telemetry]{"schema":"runner-telemetry/v1","os":"linux","arch":"x64","cpu_count":4,...}
```

| Field | Source | Unit |
|---|---|---|
| `cpu_mean`, `cpu_p95`, `cpu_max` | `/proc/stat` aggregate `cpu` line: busy (all but idle and iowait) over total jiffies between samples, all cores | fraction 0..1 |
| `memory_used_max_bytes`, `memory_used_mean_bytes`, `memory_total_bytes` | `/proc/meminfo`: `MemTotal - MemAvailable` | bytes |
| `disk_read_bytes`, `disk_write_bytes` | `/proc/diskstats`, whole disks only (`sd*`, `vd*`, `xvd*`, `hd*`, `nvme*n*`, `mmcblk*`), sectors x 512, sum of increases | bytes |
| `net_rx_bytes`, `net_tx_bytes` | `/proc/net/dev`, every interface except `lo`, sum of increases | bytes |
| `load1_max` | `/proc/loadavg` first field | load |
| `disk_free_min_bytes` | `fs.statfsSync($GITHUB_WORKSPACE)`: available blocks x block size | bytes |
| `samples`, `duration_s`, `interval_s` | the sampler | count, seconds |
| `os`, `arch`, `cpu_count` | Node `process.platform`, `os.arch()`, `os.availableParallelism()` | |

Every value is measured on the runner. A counter that cannot be read is `null` (shown as "missing"), never 0 or a
guess; fewer than two samples means no line at all. The line carries only these numbers plus `os`, `arch` and
`cpu_count`: no environment variables, paths, hostnames, process names or command lines.

## How it is used

When the job completes, the ghcaretaker collector downloads the job log (read-only `actions: read` App token), keeps
only the end of it in memory, parses the last `##[runner-telemetry]` line against the exact schema above, stores the
validated numbers and discards the log. Figures appear on `https://caretaker.vespoli.me/actions` as CPU mean, CPU
p95 and memory peak per repository, workflow and job.

Notes: any step can print a line with the marker, which is why the action must come first (its line is last) and why
the collector accepts only the strict schema; the figures are advisory, not an audit record. Network bytes count every
interface except `lo`, so container traffic can be counted twice (once on its virtual interface, once on the host
interface).
