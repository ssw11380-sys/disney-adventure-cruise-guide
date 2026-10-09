export interface ReportLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** 로그 기록 문제로 생성·저장·완료 처리가 실패하지 않게 한다. */
export function safeReportLogger(log: ReportLog | undefined): ReportLog | undefined {
  if (!log) return undefined;
  return {
    info(obj, msg) { try { log.info(obj, msg); } catch { /* 보고서 결과는 보존한다. */ } },
    warn(obj, msg) { try { log.warn(obj, msg); } catch { /* 보고서 결과는 보존한다. */ } },
  };
}

type ReportStage = "자료 수집" | "프롬프트" | "모델 생성" | "모델 상세" | "요약" | "저장 대기" | "저장" | "완료 처리";
type ReportKind = { report: "분석"; kind: "company" | "value" | "technical" } | { report: "브리핑"; session: "morning" | "afternoon" };

/**
 * 종목 보고서 한 건의 생성 진입부터 반환 직전까지 측정한다. 세션 준비·회차 완료 리스너·화면 전달은 제외한다.
 * 자료 수집에는 종목 찾기·기존 요약 조회 등 준비도 포함한다. 본문·종목·계정·오류 원문은 받지 않는다.
 */
export class ReportTiming {
  private readonly startedAt = performance.now();
  private markedAt = this.startedAt;
  private stage: ReportStage = "자료 수집";
  private failedStage: ReportStage | undefined;
  private readonly stagesMs: Partial<Record<ReportStage, number>> = {};
  private readonly log: ReportLog | undefined;

  constructor(private readonly kind: ReportKind, log?: ReportLog) {
    this.log = safeReportLogger(log);
  }

  next(stage: ReportStage): void {
    this.record(performance.now());
    this.stage = stage;
  }

  fail(): void {
    // 생성 실패를 저장하다 다시 실패해도 먼저 실패한 단계를 남긴다.
    this.failedStage ??= this.stage;
  }

  finish(success: boolean): void {
    const finishedAt = performance.now();
    this.record(finishedAt);
    this.log?.info({
      ...this.kind,
      status: success ? "완료" : "실패",
      stagesMs: this.stagesMs,
      totalMs: finishedAt - this.startedAt,
      ...(!success ? { failedStage: this.failedStage ?? this.stage } : {}),
    }, "보고서 단계별 소요 시간");
  }

  private record(at: number): void {
    this.stagesMs[this.stage] = (this.stagesMs[this.stage] ?? 0) + at - this.markedAt;
    this.markedAt = at;
  }
}
