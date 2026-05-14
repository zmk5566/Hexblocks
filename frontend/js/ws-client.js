/**
 * WearBlocks WebSocket client — singleton with auto-reconnect.
 */

class WsClient {
  constructor() {
    this._ws = null;
    this._url = '';
    this._connected = false;
    this._messageHandlers = [];
    this._statusHandlers = [];
    this._reconnectDelay = 1000;
    this._maxDelay = 10000;
    this._reconnectTimer = null;
    this._intentionalClose = false;
  }

  get connected() { return this._connected; }
  get url() { return this._url; }

  /** Register a callback for parsed JSON messages. */
  onMessage(callback) {
    this._messageHandlers.push(callback);
  }

  /** Remove a previously registered message callback. */
  offMessage(callback) {
    this._messageHandlers = this._messageHandlers.filter(h => h !== callback);
  }

  /** Register a callback for connection status changes (bool). */
  onStatus(callback) {
    this._statusHandlers.push(callback);
  }

  /** Remove a previously registered status callback. */
  offStatus(callback) {
    this._statusHandlers = this._statusHandlers.filter(h => h !== callback);
  }

  /** Send a JSON message to the bridge. */
  send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /** Request current module status from hub. */
  queryStatus() {
    this.send({ action: 'query', command: 'STATUS' });
  }

  /** Force re-discovery: hub broadcasts REDISCOVER on CAN, every module
   *  re-emits HELLO. Use when modules were powered before the hub booted, or
   *  when the user manually wants a fresh scan. STATUS only replays already-
   *  registered modules; this command is what catches unregistered ones. */
  queryDiscover() {
    this.send({ action: 'query', command: 'DISCOVER' });
  }

  /** Request authoritative topology snapshot ($T rows + final $Q,DONE).
   *  The frontend reconciles _children + module.face from the snapshot,
   *  dropping stale links accumulated from missed delta events. */
  queryTopo() {
    this.send({ action: 'query', command: 'TOPO' });
  }

  /** Request the current ECA program snapshot. Hub responds with one
   *  `eca_status` message (running/has/rules/vcs/raw_len/nvs_stored)
   *  and, if a program is loaded, one `eca_bytecode` message carrying
   *  the original base64 payload. Useful when the frontend reconnects
   *  and needs to know what the hub is already running (e.g. after a
   *  power cycle that auto-restored from NVS). */
  queryEca() {
    this.send({ action: 'query', command: 'ECA' });
  }

  // ── ECA program control ───────────────────────────────────────
  // Maps to hub commands $PR / $PS / $PC / $PE. The inspector modal
  // uses these; nothing else should call them directly.

  /** Start the loaded ECA program ($PR). Safe no-op if no program loaded. */
  programRun()      { this.send({ action: 'program_run' }); }
  /** Pause the running ECA program ($PS). Bytecode and NVS untouched. */
  programStop()     { this.send({ action: 'program_stop' }); }
  /** Clear runtime AND wipe persisted bytecode ($PC) — full forget. */
  programClear()    { this.send({ action: 'program_clear' }); }
  /** Wipe persisted bytecode only ($PE); current session keeps running. */
  programEraseNvs() { this.send({ action: 'program_erase_nvs' }); }

  /** Send a simulator-only command (e.g. 'demo1', 'demo2', 'demo3',
   *  'clear'). The bridge silently ignores these when not in a --sim
   *  mode. Used by the D1/D2/D3 preset buttons in the status bar. */
  simCommand(command) {
    this.send({ action: 'sim_command', command });
  }

  // ── OSC forwarding (Mode B) ───────────────────────────────────
  // Bridge keeps the source of truth at ~/.wearblocks/osc_targets.json.
  // Any mutation broadcasts an osc_state message; per-target stats are
  // pushed at 1 Hz as osc_stats. Initial state is replayed on connect.

  /** Ask the bridge to push the current osc_state. The bridge already
   *  replays this on connect, so explicit calls are rarely needed. */
  oscList() { this.send({ action: 'osc_list' }); }

  /** Add an OSC target. `target` shape: {host, port, enabled,
   *  sensors_filter, actuators_enabled, mappings, rate_limit_hz}. */
  oscAdd(target) { this.send({ action: 'osc_add', target }); }

  /** Update a target by id. `target` is the full new shape (server
   *  replaces, not merges). */
  oscUpdate(id, target) { this.send({ action: 'osc_update', id, target }); }

  /** Remove a target by id. */
  oscRemove(id) { this.send({ action: 'osc_remove', id }); }

  /** Replace `target.mappings` with auto-generated rows from the live
   *  hub schema. No-op if no modules are currently plugged in. */
  oscAutoPopulate(id) { this.send({ action: 'osc_auto_populate', id }); }

  /** Connect to the WebSocket bridge. */
  connect(url = 'ws://localhost:8765') {
    this._url = url;
    this._intentionalClose = false;
    this._open();
  }

  /** Gracefully disconnect. */
  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._setConnected(false);
  }

  // -- internal --

  _open() {
    try {
      this._ws = new WebSocket(this._url);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      this._reconnectDelay = 1000;
      this._setConnected(true);
      // Fire all four: DISCOVER pokes the CAN bus so any unregistered
      // module re-announces; STATUS replays hub's current registry
      // ($H + $D); TOPO returns one $T per module so the frontend can
      // reconcile parent/face state against the hub's truth (closes the
      // drift window where missed child_stack/face_swap deltas leave
      // stale links in _children); ECA returns whatever program the hub
      // is currently running so the UI reflects post-power-cycle state
      // restored from NVS.
      this.queryDiscover();
      this.queryStatus();
      this.queryTopo();
      this.queryEca();
    };

    this._ws.onclose = () => {
      this._setConnected(false);
      if (!this._intentionalClose) {
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = () => {
      // onclose will fire after this
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        for (const handler of this._messageHandlers) {
          handler(msg);
        }
      } catch {
        // ignore non-JSON
      }
    };
  }

  _setConnected(value) {
    if (this._connected !== value) {
      this._connected = value;
      for (const handler of this._statusHandlers) {
        handler(value);
      }
    }
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._open();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
  }
}

export const wsClient = new WsClient();
export default WsClient;
