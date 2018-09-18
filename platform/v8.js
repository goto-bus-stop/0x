'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const pump = require('pump')
const split = require('split2')
const through = require('through2')
const debug = require('debug')('0x')
const v8LogToTicks = require('../lib/v8-log-to-ticks')
const { promisify } = require('util')
const rename = promisify(fs.rename)
const sleep = promisify(setTimeout)

const {
  getTargetFolder,
  pathTo,
  spawnOnPort,
  when
} = require('../lib/util')

module.exports = v8

async function v8 (args, binary) {
  const { status, outputDir, workingDir, name, onPort } = args

  var node = !binary || binary === 'node' ? await pathTo('node') : binary
  var proc = spawn(node, [
    '--prof',
    `--logfile=%p-v8.log`,
    '--print-opt-source',
    '-r', path.join(__dirname, '..', 'lib', 'preload', 'no-cluster'),
    '-r', path.join(__dirname, '..', 'lib', 'preload', 'redir-stdout'),
    '-r', path.join(__dirname, '..', 'lib', 'preload', 'soft-exit'),
    ...(onPort ? ['-r', path.join(__dirname, '..', 'lib', 'preload', 'detect-port.js')] : [])
  ].concat(args.argv), {
    stdio: ['ignore', 'pipe', 'inherit', 'pipe', 'ignore', 'pipe']
  })

  const inlined = collectInliningInfo(proc)

  if (onPort) status('Profiling\n')
  else status('Profiling')

  proc.stdio[3].pipe(process.stdout)

  let closeTimer
  let softClosed = false
  const softClose = () => {
    if (softClosed) return
    softClosed = true
    status('Waiting for subprocess to exit...')
    closeTimer = setTimeout(() => {
      status('Closing subprocess is taking a long time, it might have hung. Press Ctrl+C again to force close')
    }, 3000)
    // Stop the subprocess; force stop it on the second SIGINT
    proc.stdio[5].destroy()

    onsigint = forceClose
    process.once('SIGINT', onsigint)
  }
  const forceClose = () => {
    status('Force closing subprocess...')
    proc.kill()
  }

  let onsigint = softClose
  process.once('SIGINT', onsigint)
  process.once('SIGTERM', forceClose)
  process.on('exit', forceClose)

  const whenPort = onPort && spawnOnPort(onPort, await when(proc.stdio[5], 'data'))

  let onPortError
  if (onPort) {
    // Graceful close once --on-port process ends
    onPortError = whenPort.then(() => {
      process.removeListener('SIGINT', onsigint)
      softClose()
    }, (err) => {
      proc.kill()
      throw err
    })
  }

  const code = await Promise.race([
    when(proc, 'exit'),
    // This never resolves but may reject.
    // When the --on-port process ends, we still wait for proc's 'exit'.
    onPortError
  ].filter(Boolean))

  clearTimeout(closeTimer)
  process.removeListener('SIGINT', onsigint)
  process.removeListener('SIGTERM', forceClose)
  process.removeListener('exit', forceClose)

  if (code|0 !== 0) {
    throw Object.assign(Error('Target subprocess error, code: ' + code), { code })
  }

  const folder = getTargetFolder({outputDir, workingDir, name, pid: proc.pid})

  status('Process exited, generating flamegraph')

  debug('moving isolate file into folder')
  const isolateLog = fs.readdirSync(args.workingDir).find(function (f) {
    return new RegExp(`isolate-0(x)?([0-9A-Fa-f]{2,16})-${proc.pid}-v8.log`).test(f)
  })

  if (!isolateLog) throw Error('no isolate logfile found')

  const isolateLogPath = path.join(folder, isolateLog)
  await renameSafe(path.join(args.workingDir, isolateLog), isolateLogPath)
  return {
    ticks: await v8LogToTicks(isolateLogPath, node),
    inlined: inlined,
    pid: proc.pid,
    folder: folder
  }
}

async function renameSafe (from, to, tries = 0) {
  try {
    await rename(from, to)
  } catch (e) {
    if (tries > 5) {
      throw e
    }
    await sleep(1000)
    await renameSafe(from, to, tries++)
  }
}

function collectInliningInfo (sp) {
  var root
  var stdoutIsPrintOptSourceOutput = false
  var lastOptimizedFrame = null
  var inlined = {}
  pump(sp.stdout, split(), through((s, _, cb) => {
    s += '\n'

    if (stdoutIsPrintOptSourceOutput === true && /^--- END ---/.test(s)) {
      stdoutIsPrintOptSourceOutput = false
      return cb()
    }
    // trace data
    if (stdoutIsPrintOptSourceOutput === false) {
      if (/INLINE/.test(s)) {
        const [ match, inlinedFn ] = /INLINE \((.*)\)/.exec(s) || [ false ]
        // shouldn't not match though..
        if (match === false) return cb()

        if (lastOptimizedFrame === null) return cb()
        const { fn, file } = lastOptimizedFrame
        // could be a big problem if the fn doesn't match
        if (fn !== inlinedFn) return cb()

        const key = `${fn} ${file}`
        inlined[key] = inlined[key] || []
        inlined[key].push(lastOptimizedFrame)
        cb()
        return
        // Reading v8 output from the stdout stream is sometimes unreliable. The next
        // FUNCTION SOURCE can be in the middle of a previous FUNCTION SOURCE, cutting
        // it off. The impact can be alleviated slightly by accepting FUNCTION SOURCE
        // identifiers that occur in the middle of a line.
        // The previous FUNCTION SOURCE block will not have been closed, but END lines
        // only set `stdoutIsPrintOptSourceOutput` to false, so we don't have to do
        // anything here. If the END logic changes the below may need to change as well.
        //
        // ref: https://github.com/davidmarkclements/0x/issues/122
      } else if (/--- FUNCTION SOURCE \(.*?\) id\{\d+,-?\d+\} start\{\d+\} ---\n$/.test(s)) {
        stdoutIsPrintOptSourceOutput = true
        const [match, file, fn = '(anonymous)', id, ix, pos] = /\((.+):(.+)?\) id\{(\d+),(-?\d+)\} start\{(\d+)}/.exec(s) || [false]
        if (match === false) return cb()
        if (ix === '-1') root = {file, fn, id, ix, pos, key: `${fn} ${file}`}
        else {
          lastOptimizedFrame = {file, fn, id, ix, pos, caller: root}
        }
      } else process.stdout.write(s)
    }

    cb()
  }))
  return inlined
}
