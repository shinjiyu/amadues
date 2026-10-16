/**
 * JEV system-one：对一段文本做是否完成的判断。
 * 与 jev-debug 的 client.yes_no 同一接口，不扫仓库。
 */
const API_URL = 'https://api.typesafe.ai/v1/systemone';

export interface JevVerdict {
  done: boolean;
  choice: 'yes' | 'no';
}

export async function askJev(
  task: string,
  artifact: string,
  opts?: { fetch?: typeof fetch; token?: string },
): Promise<JevVerdict> {
  const token = opts?.token ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_KEY;
  if (!token) throw new Error('missing TYPESAFE_API_KEY or JEV_KEY');
  const call = opts?.fetch ?? fetch;
  const response = await call(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'jev-latest',
      state: `TASK:\n${task}\n\nARTIFACT:\n${artifact}`,
      questions: {
        done: {
          type: 'choice',
          instructions: 'Does this artifact complete the task?',
          criteria: { yes: 'Yes.', no: 'No.' },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`JEV HTTP ${response.status}`);
  const payload = (await response.json()) as {
    answers?: { done?: { choice?: string } };
  };
  const choice = payload.answers?.done?.choice === 'yes' ? 'yes' : 'no';
  return { done: choice === 'yes', choice };
}
