import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26 char time-sortable id (ULID layout). Order within one millisecond is not guaranteed. */
export function ulid(nowMs: number = Date.now()): string {
  let t = nowMs;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ENC[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (const b of randomBytes(16)) rand += ENC[b % 32]!;
  return time + rand;
}
