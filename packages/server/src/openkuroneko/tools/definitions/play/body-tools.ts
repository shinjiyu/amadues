/**
 * OnlyClaws Play body tools — call the localhost body bridge.
 * Agent never gets shell; Node fetches http://127.0.0.1:8766/...
 *
 * Env: PLAY_BRIDGE_URL (default http://127.0.0.1:8766)
 */

import type { Tool } from '../../index.js';

function bridgeBase(): string {
  return (process.env['PLAY_BRIDGE_URL'] ?? 'http://127.0.0.1:8766').replace(/\/$/, '');
}

async function bridgePost(path: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; output: string }> {
  const url = `${bridgeBase()}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
    const ok = res.ok && !(typeof parsed === 'object' && parsed && (parsed as { ok?: boolean }).ok === false);
    return {
      ok,
      output: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2),
    };
  } catch (e) {
    return { ok: false, output: `play bridge error: ${String(e)} (is bridge running at ${url}?)` };
  }
}

export const armFeedbackTool: Tool = {
  name: 'arm_feedback',
  description: 'Read RoArm joint radians q=[base,shoulder,elbow,wrist]. Does not move.',
  parameters: {},
  async call() {
    return bridgePost('/arm/feedback');
  },
};

export const armStreamTool: Tool = {
  name: 'arm_stream',
  description:
    'Move RoArm to absolute q (4 radians) at spd (servo steps/s, ~20-800). ' +
    'Bridge clamps absolute limits and per-call step size. Prefer small steps; call arm_feedback between moves.',
  parameters: {
    q: { type: 'array', description: 'Target [base, shoulder, elbow, wrist] radians' },
    spd: { type: 'number', description: 'Servo step rate, default 120' },
  },
  required: ['q'],
  async call(args) {
    const q = args['q'];
    if (!Array.isArray(q) || q.length < 4) {
      return { ok: false, output: 'q must be an array of 4 numbers' };
    }
    const spd = args['spd'] == null ? 120 : Number(args['spd']);
    return bridgePost('/arm/stream', { q: q.slice(0, 4).map(Number), spd });
  },
};

export const armStopTool: Tool = {
  name: 'arm_stop',
  description: 'Halt RoArm motion (arm.stop).',
  parameters: {},
  async call() {
    return bridgePost('/arm/stop');
  },
};

export const eyeLookTool: Tool = {
  name: 'eye_look',
  description:
    'Grab one tip-cam JPEG and describe what is visible (not who). ' +
    'Returns path + Chinese description from the vision model. No face identity.',
  parameters: {
    width: { type: 'number', description: 'Max image width, default 960' },
  },
  async call(args) {
    const width = args['width'] == null ? 960 : Number(args['width']);
    return bridgePost('/eye/look', { width });
  },
};

export const screenShowTool: Tool = {
  name: 'screen_show',
  description: 'Show short text on the OnlyClaws ESP32 panel (title + body). No beep.',
  parameters: {
    title: { type: 'string', description: 'Short title' },
    body: { type: 'string', description: 'Body text, up to 4000 chars' },
  },
  required: ['body'],
  async call(args) {
    return bridgePost('/screen/show', {
      title: String(args['title'] ?? ''),
      body: String(args['body'] ?? ''),
    });
  },
};

export const mouthSayTool: Tool = {
  name: 'mouth_say',
  description:
    'Speak aloud through the board speaker (Chinese TTS only). ' +
    'text MUST be short spoken Mandarin with 汉字 (one sentence, ≤80 chars). ' +
    'English/latin text is rejected — the speaker cannot pronounce it. ' +
    'This is your voice to the room, not a status log: do not dump reports, file contents, or joint angles. ' +
    'voice: girl|boy.',
  parameters: {
    text: {
      type: 'string',
      description: 'Short spoken Chinese (汉字). Example: 我看到夹爪下面有根红白线。',
    },
    voice: { type: 'string', description: 'girl or boy, default girl' },
  },
  required: ['text'],
  async call(args) {
    return bridgePost('/mouth/say', {
      text: String(args['text'] ?? ''),
      voice: String(args['voice'] ?? 'girl'),
    });
  },
};

export const PLAY_BODY_TOOLS: Tool[] = [
  armFeedbackTool,
  armStreamTool,
  armStopTool,
  eyeLookTool,
  screenShowTool,
  mouthSayTool,
];
