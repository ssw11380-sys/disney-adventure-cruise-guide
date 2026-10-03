/** 실제 별도 프로세스 장애 검사용. 자료·모델·푸시는 가짜이며 외부 HTTP를 금지한다. */
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/index.js";
import type { GenerateRequest } from "../../src/llm/generator.js";
import type { PushMessage, PushSender } from "../../src/notifications/push.js";
import { FakeGenerator, fakeProviders } from "../helpers.js";

const database = process.env["REMAINING_TEST_DATABASE"];
if (!database || !process.send) throw new Error("격리 검증 프로세스에서만 실행합니다");
globalThis.fetch = async () => { throw new Error("검증 중 외부 HTTP 금지"); };
const send = (event: string, data: object = {}) => process.send?.({ event, ...data });
let held = true;
let holdSummaryOnly = false;
let release!: () => void;
const barrier = new Promise<void>((resolve) => { release = resolve; });
class Generator extends FakeGenerator {
  override async generate(request: GenerateRequest) {
    send("model", { label: request.label });
    if (request.label?.startsWith("briefing_summary")) send("summary");
    if (held && (!holdSummaryOnly || request.label?.startsWith("briefing_summary"))) await barrier;
    return super.generate(request);
  }
}
class Push implements PushSender {
  readonly name = "격리 가짜 푸시";
  isValidToken() { return true; }
  async send(tokens: string[], _message: PushMessage) {
    send("push", { count: tokens.length });
    return { results: tokens.map((token, i) => ({ token, ok: true, error: null, receiptId: `remaining-${process.pid}-${i}` })) };
  }
  async checkReceipts(ids: string[]) {
    send("receipt", { count: ids.length });
    return ids.map((receiptId) => ({ receiptId, ok: false, error: "DeviceNotRegistered" }));
  }
}
const db = createDb(database).db;
const app = await buildApp({
  db, config: loadConfig({ DATABASE_URL: database }),
  providers: fakeProviders({ generator: new Generator(), push: new Push() }),
  logger: false, enableScheduler: false, receiptDelayMs: 60_000,
  generationJobTiming: { leaseMs: 3_000, pollMs: 20 },
  now: () => new Date("2026-12-28T09:00:00+09:00"),
});
process.on("message", (message: { command: string; id: string; requestId?: string }) => {
  if (message.command === "release") { held = false; release(); return; }
  void (async () => {
    let result: unknown;
    switch (message.command) {
      case "analysis": result = await app.analysisService.getTracked("005930", "company", message.requestId ?? message.id, { refresh: true }); break;
      case "briefing": result = await app.briefingService.runSession("morning"); break;
      case "briefing-summary-hold": holdSummaryOnly = true; result = await app.briefingService.runSession("morning", { force: true }); break;
      case "briefing-force": result = await app.briefingService.runSession("morning", { force: true }); break;
      case "state": result = await app.analysisService.state("005930", "company", message.requestId ?? message.id); break;
      case "progress": result = { progress: await app.briefingService.currentProgress(), settings: (await app.inject({ method: "GET", url: "/api/notifications/settings" })).json() }; break;
      case "send": result = await app.notificationService.sendTest(); break;
      case "receipts": result = await app.notificationService.checkReceipts(); break;
      case "stop": await app.close(); await db.destroy(); send("result", { id: message.id }); process.disconnect(); return;
      default: throw new Error("알 수 없는 검증 명령");
    }
    send("result", { id: message.id, result });
  })().catch((error: unknown) => send("result", { id: message.id, error: error instanceof Error ? error.message : String(error) }));
});
send("ready");
