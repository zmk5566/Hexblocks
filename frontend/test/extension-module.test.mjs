import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EXTENSION_BOARD, isExtensionRequest } from '../js/data/extension-board.js';

// Exercise the actual conversation methods without CDN/browser dependencies.
// Lit rendering itself is checked in the browser.
const source = await readFile(new URL('../js/components/wb-llm-panel.js', import.meta.url), 'utf8');
const profileUrl = new URL('../js/data/extension-board.js', import.meta.url).href;
const prelude = `
import { EXTENSION_BOARD, isExtensionRequest, extensionPrompt } from '${profileUrl}';
const window = {};
const customElements = { define() {} };
class LitElement { requestUpdate() {} }
const html = (parts, ...values) => parts.reduce((s, p, i) => s + p + (values[i] ?? ''), '');
const css = html;
const channelsForModule = () => [];
const formatCatalog = () => 'imu, led';
`;
const { WbLlmPanel } = await import('data:text/javascript;base64,' + Buffer.from(
  prelude + source.replace(/^import[\s\S]*?;\n/gm, ''),
).toString('base64'));

test('custom hardware requests route locally, existing kit requests do not', () => {
  for (const text of ['我想添加一个温度传感器', '我要自己做新模块', 'connect a custom module']) {
    assert.equal(isExtensionRequest(text), true, text);
  }
  assert.equal(isExtensionRequest('让 LED 在摇晃时亮起来'), false);
  assert.equal(isExtensionRequest('我需要哪些模块'), false);
});

test('short follow-ups stay in extension mode, explicit exit restores classifier', async () => {
  const panel = new WbLlmPanel();
  panel._startExtension();
  assert.equal(await panel._classifyIntent('换一个脚行吗'), 'extend_module');
  panel._endExtension();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '<intent>generate_rules</intent>' } }] }) });
  try { assert.equal(await panel._classifyIntent('让 LED 亮起来'), 'generate_rules'); }
  finally { globalThis.fetch = oldFetch; }
});

test('wiring turns preserve history and never surface executable model envelopes', async () => {
  const panel = new WbLlmPanel();
  const requests = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const content = '<workspace_update>{"rules":[]}</workspace_update><module_recommendation>{"modules":["led"]}</module_recommendation>';
    return { ok: true, body: new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n'));
      c.close();
    } }) };
  };
  try {
    panel._inputValue = '我想添加一个新模块';
    await panel._onSend();
    panel._inputValue = '换一个脚行吗';
    await panel._onSend();
    assert.equal(requests.length, 2); // No classifier request on either turn.
    assert.equal(panel._proposedRules, null);
    assert.equal(panel._activePlan, null);
    assert.equal(requests[1].messages[1].content, '我想添加一个新模块');
    assert.match(requests[1].messages[0].content, /J16: pin 1 = GPIO3; pin 2 = GPIO4; pin 3 = GPIO5; pin 4 = GPIO10/);
    assert.match(requests[1].messages[0].content, /CHILD_DETECT/);
    assert.equal(panel._extensionMode, true);
  } finally { globalThis.fetch = oldFetch; }
});

test('diagram and prompt use the same connector facts', () => {
  const panel = new WbLlmPanel();
  panel._startExtension();
  const diagram = panel._renderExtensionGuide();
  const prompt = panel._buildSystemPrompt('extend_module');
  for (const connector of EXTENSION_BOARD.connectors) {
    assert.ok(diagram.includes(connector.name));
    connector.pins.forEach((net, i) => {
      assert.ok(diagram.includes(net));
      assert.ok(prompt.includes(`pin ${i + 1} = ${net}`));
    });
  }
});
