import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { FastifyPluginAsync } from "fastify";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { MarketIndices } from "../providers/market/indices.js";
import type { BriefingService } from "../services/briefingService.js";
import type { FeatureService } from "../services/featureService.js";
import type { StockService } from "../services/stockService.js";
import { buildWidgetPayload, widgetBrief, type BriefSchedule, type WidgetFeatures } from "../services/widgetPayload.js";

/**
 * GET /api/widget — 홈 화면 위젯(잔고·브리핑·자산, 1.4.0 부터 지수·환율까지)이 같이 쓰는 한 번의 응답 (3-16).
 * ETag 가 같으면 304(본문 없음), gzip 을 받으면 압축해서 보낸다 (휴장일 위젯 트래픽을 줄이려고).
 * ETag 는 본문으로 만들므로 지수·플래그가 바뀌면 달라지고, 값이 같으면(휴장 중 지수) 그대로 304 다.
 *  - features: 위젯이 쓰는 플래그 (widgetPnlToggle·widgetIndexLine·widgetMarket)
 *  - indices: widgetIndexLine 이 켜져 있고 앱이 ?indices=1 로 물을 때만 지수 띠와 같은 목록(같은 인스턴스·30초 캐시·stale 규칙)에서
 *    코스피·나스닥·원/달러. 지수 줄을 그리지 않는 예전 앱(쿼리 없음)에는 넣지도 부르지도 않는다 — 한국 종목만 가진 사용자가
 *    장이 닫힌 뒤에도 나스닥·환율이 바뀌어 304 대신 200 을 받지 않게. 끄면 지수를 부르지도 않는다. 지수를 못 받으면 빼고 보낸다(위젯은 줄을 감춘다)
 *  - board: widgetMarket 이 켜져 있고 앱이 ?board=1 로 물을 때만(지수·환율 위젯이 있는 1.4.0 앱) 같은 목록에서 9개.
 *    indices 와 board 를 함께 물어도 지수 목록은 한 번만 부른다. 못 받으면 빼고 보낸다(위젯은 마지막 판을 둔다)
 *  - accountIds: accountBriefing(3-31)이 켜져 있으면 최근 성공한 계좌 브리핑 id (앱 백그라운드 알림용). 끄거나 없으면 넣지 않는다(응답이 예전과 같다)
 *  - sessions: 앱이 &sessions=1 로 물을 때만 장 상태 칩에 보유 종목의 세션 이름(미국 주간거래 등)을 쓴다 (widgetPayload.marketChip).
 *    그 앱은 위젯을 바로 그릴 때(WidgetBridge)도 같은 칩을 그린다. 예전 앱(쿼리 없음)의 WidgetBridge 는 달력만 본 칩을 그리므로
 *    예전처럼 달력만 본 칩을 준다 — 서버가 OTA 보다 먼저 배포돼도 앱을 열고 닫을 때와 위젯이 갱신할 때 칩이 번갈아 바뀌지 않게
 *  - ui=2: 다듬은 잔고 위젯·브리핑 안내를 그릴 수 있는 새 앱. brief(브리핑 시간·최신 브리핑 실패 수, BH-68)를 넣고,
 *    widgetPolish 가 켜져 있으면 칩의 시장별 문구와 지수 줄 다섯 개(코스피·코스닥·나스닥·S&P500·원/달러)를 준다. 예전 앱(표시 없음)의 응답은 그대로
 *  - widgetExtended 가 켜져 있고 &sessions=1 이면 칩에 시장별 연장 세션 열림(market.ext — 미국 프리·애프터·주간거래 등). 새 앱은 이때도 장중처럼
 *    15분마다 갱신하고 '지연'을 따진다. 새 요청 표시를 더하지 않는 것은 1.4.0 지금 JS 도 &sessions=1 로 묻고 모르는 칸을 무시하기 때문이다
 *    (주소를 바꾸면 받아 둔 응답을 한 번 버린다). 칩의 다른 칸은 그대로라 예전 앱의 모습·갱신 주기는 바뀌지 않는다
 */
export const widgetRoutes: FastifyPluginAsync<{
  stocks: StockService;
  briefings: BriefingService;
  calendar: MarketCalendar;
  features?: FeatureService;
  indices?: MarketIndices;
  accounts?: { recentOkIds(limit?: number): Promise<number[]> };
  /** 알림 설정의 브리핑 시간 (브리핑 위젯 안내 BH-68). 없거나 못 읽으면 안내에 시간을 넣지 않는다 */
  schedule?: () => Promise<BriefSchedule>;
}> = async (app, deps) => {
  const flags = async (): Promise<WidgetFeatures | undefined> => {
    if (!deps.features) return undefined;
    const [widgetPnlToggle, widgetIndexLine, widgetMarket, widgetPolish, widgetExtended, widgetFoldFit] = await Promise.all([
      deps.features.enabled("widgetPnlToggle"),
      deps.features.enabled("widgetIndexLine"),
      deps.features.enabled("widgetMarket"),
      deps.features.enabled("widgetPolish"),
      deps.features.enabled("widgetExtended"),
      deps.features.enabled("widgetFoldFit"),
    ]);
    return { widgetPnlToggle, widgetIndexLine, widgetMarket, widgetPolish, widgetExtended, widgetFoldFit };
  };
  app.get("/", async (req, reply) => {
    const features = flags();
    const q = req.query as { indices?: unknown; board?: unknown; sessions?: unknown; ui?: unknown } | undefined;
    const wantsIndices = q?.indices === "1";
    const wantsBoard = q?.board === "1";
    const wantsSessions = q?.sessions === "1";
    const newUi = q?.ui === "2";
    const schedule = newUi && deps.schedule ? deps.schedule().catch(() => null) : null;
    const indices = features.then((f) =>
      deps.indices && ((wantsIndices && f?.widgetIndexLine) || (wantsBoard && f?.widgetMarket)) ? deps.indices.list({ stale: true }).catch(() => null) : null,
    );
    const accounts =
      deps.features && deps.accounts
        ? deps.features
            .enabled("accountBriefing")
            .then((on) => (on ? deps.accounts!.recentOkIds(4) : null))
            .catch(() => null)
        : null;
    const [list, latest, status, f, idx, accountIds, sched] = await Promise.all([deps.stocks.listWithQuotes(), deps.briefings.latestPerStock(), deps.calendar.status().catch(() => null), features, indices, accounts, schedule]);
    const body = JSON.stringify(
      buildWidgetPayload(list, latest, status, {
        features: f,
        indices: wantsIndices ? idx : null,
        board: wantsBoard ? idx : null,
        accountIds,
        sessions: wantsSessions,
        polish: newUi && f?.widgetPolish === true,
        brief: newUi ? widgetBrief(latest, sched) : null,
        extended: wantsSessions && f?.widgetExtended === true,
      }),
    );
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
    reply.header("etag", etag).header("cache-control", "no-cache").header("vary", "accept-encoding");
    // 프록시가 약한 ETag(W/"…")로 바꾸거나 여러 개를 보내도 맞춰 본다
    const inm = String(req.headers["if-none-match"] ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
    if (inm.includes(etag)) return reply.code(304).send();
    reply.type("application/json; charset=utf-8");
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return reply.header("content-encoding", "gzip").send(gzipSync(body));
    return reply.send(body);
  });
};
