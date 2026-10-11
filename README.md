# Panda Bench

Tablet setup tool for Panda Eats order-taking tablets.

Plug a tablet into a Windows PC over USB, check it, press Apply, and it comes out ready for
all-day counter duty: the screen stays on, the sound stays up, the order app is allowed to keep
running in the background, and preinstalled apps it does not need are switched off.

**No root. No factory reset. Everything reversible.** It works over `adb`, so it is safe on a
tablet that is already in use at a restaurant. Every Apply saves a rollback point before it
changes anything, and nothing is uninstalled: apps are only disabled, and come back on rollback.

## Install

Download the installer from [Releases](../../releases/latest). An installed copy checks for
updates when it starts and only restarts when you say so.

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
