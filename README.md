# Panda Bench

Tablet setup tool for Panda Eats order-taking tablets.

Plug a tablet into a Windows PC over USB, check it, press Apply, and it comes out ready for
all-day counter duty: the screen stays on, the sound stays up, the order app is allowed to keep
running in the background, and apps named in its bloat profiles are removed or switched off.

**No root. No factory reset.** Built-in apps are switched off and can be restored. Profile-named
apps installed in /data/app are deleted for good with their data. The audit and Apply plan list
permanent deletions separately, and protected and Panda Eats apps are never removed. Every Apply
saves a record first, but Bench cannot restore deleted apps or their data.

## Install

Download the installer from
[Releases](https://github.com/naft3r-101/panda-bench-releases/releases/latest). An installed
copy checks for updates when it starts and only restarts when you say so.

On the tablet: turn on Developer options and **USB debugging**, plug it in, and accept the prompt
on the tablet's screen.

## Run from source

```bash
pnpm install
pnpm start
```

## Tests

```bash
pnpm test
```

## More

The operator guide, covering each step, the checks, rollback and the known limits, is in
[docs/operator-guide.md](docs/operator-guide.md).
