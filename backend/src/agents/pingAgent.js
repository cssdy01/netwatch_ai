// src/agents/pingAgent.js — ICMP ping using child_process exec (most reliable)
// Uses the system `ping` command directly — same binary available on all Linux/Windows.
// Falls back gracefully with a clear error if ping is not in PATH.

const { exec } = require('child_process');
const os = require('os');

/**
 * Detect whether the OS is Windows.
 */
const IS_WIN = os.platform() === 'win32';

/**
 * Build platform-appropriate ping command.
 * Linux/Mac:  ping -c 1 -W 5 <target>
 * Windows:    ping -n 1 -w 5000 <target>
 */
function buildPingCmd(target) {
  // Sanitize target — only allow safe hostname/IP chars
  const safe = target.replace(/[^a-zA-Z0-9.\-:]/g, '');
  if (!safe) throw new Error('Invalid target: empty after sanitization');

  if (IS_WIN) {
    return `ping -n 1 -w 5000 ${safe}`;
  }
  return `ping -c 1 -W 5 ${safe}`;
}

/**
 * Parse response time from ping output.
 * Linux:   time=12.3 ms
 * Windows: time=12ms  or  temps=12ms
 */
function parseResponseMs(output) {
  const match = output.match(/[Tt]ime[=<](\d+(?:\.\d+)?)\s*ms/);
  if (match) return Math.round(parseFloat(match[1]));
  return null;
}

/**
 * Run a ping check.
 * @param {object} task
 * @returns {{ result: 'PASS'|'FAIL', responseMs: number|null, errorRaw: string|null, endpointResults: null }}
 */
async function run(task) {
  const start = Date.now();

  return new Promise((resolve) => {
    let cmd;
    try {
      cmd = buildPingCmd(task.target);
    } catch (err) {
      return resolve({
        result: 'FAIL',
        responseMs: 0,
        errorRaw: `Ping config error: ${err.message}`,
        endpointResults: null,
      });
    }

    exec(cmd, { timeout: 12000 }, (error, stdout, stderr) => {
      const elapsed = Date.now() - start;
      const output = (stdout || '') + (stderr || '');

      if (error) {
        // Timeout
        if (error.killed || error.code === null) {
          return resolve({
            result: 'FAIL',
            responseMs: elapsed,
            errorRaw: `Ping timeout — host ${task.target} did not respond within 10s`,
            endpointResults: null,
          });
        }

        // Non-zero exit = host unreachable
        // Extract useful line from ping output
        const lines = output.split('\n').filter(l => l.trim());
        const errLine = lines.find(l =>
          /unreachable|timeout|unknown|failure|error|cannot/i.test(l)
        ) || lines[lines.length - 1] || `ping exited with code ${error.code}`;

        return resolve({
          result: 'FAIL',
          responseMs: elapsed,
          errorRaw: `Host ${task.target} unreachable — ${errLine.trim()}`,
          endpointResults: null,
        });
      }

      // Success — parse time
      const responseMs = parseResponseMs(output) || elapsed;
      resolve({
        result: 'PASS',
        responseMs,
        errorRaw: null,
        endpointResults: null,
      });
    });
  });
}

module.exports = { run };
