import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Reconnect to the same read-only event stream; never resubmit a prompt here.
export function followSession({ connect, page, address, requestId, onEvent, onCheckpoint, onStatus,
  reconnectDelays = [1000, 2000, 5000, 10000, 30000], maxRetries = 8,
  heartbeatMs = 30000, snapshotTimeoutMs = 20000 }) {
  let socket, retryTimer, heartbeat, snapshotTimer;
  let stopped = false, opened = false, attempts = 0, lastSeq, turn, requestTurn;
  let work = Promise.resolve();
  let readyResolve, readyReject, doneResolve, doneReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  ready.catch(() => {});
  done.catch(() => {});
  function finish(error, reason) {
    if (stopped) return;
    stopped = true;
    clearTimeout(retryTimer); clearTimeout(snapshotTimer); clearInterval(heartbeat);
    socket?.terminate();
    if (error) { readyReject(error); doneReject(error); }
    else doneResolve(reason);
  }
  async function accept(event) {
    if (stopped || event.seq <= lastSeq) return;
    assert.equal(event.seq, lastSeq + 1, 'DSH event history has a gap');
    if (event.type === 'turn/start') turn = event.data.turn;
    const message = event.data?.message || event.data;
    if (event.type === 'user/message' && message?.source?.rpcId === requestId) requestTurn = turn;
    const belongs = requestTurn !== undefined && turn === requestTurn;
    await onEvent(event, belongs);
    lastSeq = event.seq;
    onCheckpoint(lastSeq);
    attempts = 0;
    if (event.type === 'turn/end' && belongs && event.data.turn === requestTurn) finish(null, event.data.reason);
  }
  async function snapshot(value) {
    clearTimeout(snapshotTimer);
    if (!opened) {
      lastSeq = value.cursor;
      opened = true;
      onCheckpoint(lastSeq);
      onStatus({ status: 'connected', attempts: 0 });
      readyResolve();
      return;
    }
    assert(value.cursor >= lastSeq, 'DSH event cursor moved backwards');
    let records = value.records.map(record => record.event);
    let hasMore = value.hasMore;
    let first = records[0]?.seq ?? value.cursor + 1;
    while (first > lastSeq + 1 && hasMore) {
      const older = await page({ throughSeq: value.cursor, beforeSeq: first, maxMessages: 50 });
      assert(older.records.length && older.records[0].event.seq < first, 'DSH history pagination made no progress');
      records = older.records.map(record => record.event).concat(records);
      first = records[0].seq;
      hasMore = older.hasMore;
    }
    for (const event of records) await accept(event);
    if (!stopped) {
      assert.equal(lastSeq, value.cursor, 'DSH snapshot did not cover the missing events');
      onStatus({ status: 'connected', attempts });
    }
  }
  function start() {
    if (stopped) return;
    let failed = false, local, alive = true;
    function disconnected(error) {
      if (failed || stopped) return;
      failed = true;
      clearTimeout(snapshotTimer); clearInterval(heartbeat);
      local?.terminate();
      work.then(() => {
        if (stopped) return;
        if (!opened || ++attempts > maxRetries) return finish(error);
        onStatus({ status: 'reconnecting', attempts, error: error.message });
        retryTimer = setTimeout(start, reconnectDelays[Math.min(attempts - 1, reconnectDelays.length - 1)]);
      }).catch(finish);
    }
    Promise.resolve().then(connect).then(ws => {
      local = ws;
      if (stopped) { ws.on('error', () => {}); ws.terminate(); return; }
      socket = ws;
      snapshotTimer = setTimeout(() => disconnected(Error('DSH event snapshot timed out')), snapshotTimeoutMs);
      ws.on('error', disconnected);
      ws.on('close', () => disconnected(Error('DSH event connection closed')));
      ws.on('pong', () => { alive = true; });
      ws.on('open', () => {
        try {
          ws.send(JSON.stringify({ type: 'open', streamId: 'task', endpoint: 'session/follow', payload: { args: { request: { address } } } }));
        } catch (error) { disconnected(error); return; }
        heartbeat = setInterval(() => {
          if (!alive) return disconnected(Error('DSH event heartbeat timed out'));
          alive = false;
          try { ws.ping(); } catch (error) { disconnected(error); }
        }, heartbeatMs);
      });
      ws.on('message', bytes => {
        work = work.then(async () => {
          if (stopped) return;
          const frame = JSON.parse(bytes.toString());
          if (frame.type === 'error' || frame.type === 'end') {
            disconnected(Error(frame.error?.message || 'DSH event stream ended'));
          } else if (frame.value?.type === 'snapshot') await snapshot(frame.value);
          else if (frame.value?.type === 'event') await accept(frame.value.event);
        });
        work.catch(finish);
      });
    }).catch(disconnected);
  }
  start();
  return { ready, done, close: () => finish(Error('DSH event follower stopped')) };
}

export async function deliverWithRetry({ dir, state, threadId, send, sleep = delay,
  retryDelays = [1000, 5000, 15000, 30000] }) {
  assert(state.runId && threadId, 'Delivery requires a run ID and originating thread');
  const file = path.join(dir, 'delivery.json');
  const lock = path.join(dir, '.delivery.lock');
  const handle = fs.openSync(lock, 'wx');
  let delivery;
  const save = () => fs.writeFileSync(file, JSON.stringify(delivery, null, 2) + '\n');
  try {
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (previous?.runId === state.runId && previous.queued) return previous;
    const reviewPath = path.join(dir, 'review.json');
    const review = fs.existsSync(reviewPath) ? JSON.parse(fs.readFileSync(reviewPath, 'utf8')) : null;
    if (review?.runId === state.runId) return { runId: state.runId, status: 'reviewed', queued: true };
    delivery = previous?.runId === state.runId ? previous : {
      runId: state.runId, threadId, sessionId: state.sessionId, executionStatus: state.executionStatus || state.status,
      status: 'pending', queued: false, attempts: 0,
    };
    if (['sending', 'uncertain'].includes(delivery.status)) {
      delivery.status = 'uncertain'; save();
      throw Error('Previous callback outcome is uncertain; check the Codex queue before retrying');
    }
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      delivery.status = 'sending';
      delivery.attempts = (delivery.attempts || 0) + 1;
      delivery.time = new Date().toISOString();
      save();
      let result;
      try { result = await send(); }
      catch (error) { result = { status: null, error }; }
      delivery.receipt = ((result.stdout || '') + (result.stderr || '') || result.error?.message || '').trim().slice(0, 2000);
      const acknowledged = /Queued message \S+ for thread /.test(result.stdout || '');
      delivery.queued = result.status === 0 || acknowledged;
      if (delivery.queued) { delivery.status = 'queued'; save(); return delivery; }
      const uncertain = result.status == null && !['ENOENT', 'EACCES', 'EPERM'].includes(result.error?.code);
      delivery.status = uncertain ? 'uncertain' : 'failed';
      save();
      if (uncertain) throw Error('Callback may have been queued before timeout; inspect delivery.json before retrying');
      if (attempt < retryDelays.length) await sleep(retryDelays[attempt]);
    }
    throw Error('Codex callback failed; retry delivery only, not the DSH task');
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}
