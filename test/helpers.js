import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";

const OUTPUT_CAP = 8 * 1024 * 1024;

/**
 * A child_process exec with the Herdr runtime's contract: resolves with
 * {code, stdout, stderr} for any exit code, rejects when the program cannot
 * start, and cuts each stream at 8 MiB.
 */
export function nodeExec(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "" };
    for (const name of ["stdout", "stderr"]) {
      child[name].setEncoding("utf8");
      child[name].on("data", (chunk) => {
        if (out[name].length < OUTPUT_CAP) out[name] = (out[name] + chunk).slice(0, OUTPUT_CAP);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, ...out }));
  });
}

export function writeExecutable(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

export const verdict = (over = {}) => ({
  kind: "onedev",
  host: "http://192.0.2.30:6610",
  project: "team/app",
  projectId: 72,
  ...over,
});

export const wireRow = (number, over = {}) => ({
  id: 1000 + number,
  number,
  title: `Issue ${number}`,
  state: "Open",
  updated: "2026-11-03T10:00:00.000Z",
  description: "body",
  confidential: false,
  fields: { Assignees: null, Tags: ["a"] },
  submitter: { id: 3, login: "john" },
  submitDate: "2026-11-01T10:00:00.000Z",
  commentCount: 2,
  stateOrdinal: 0,
  ...over,
});

export function fakeExec(answer) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answer(args, cmd);
  };
  exec.calls = calls;
  return exec;
}

export const reply = (stdout, code = 0, stderr = "") => ({ code, stdout, stderr });
