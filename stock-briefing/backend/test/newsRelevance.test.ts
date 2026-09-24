import { describe, expect, it } from "vitest";
import { coreName, filterNews, isAmbiguous, newsQuery } from "../src/providers/news/relevance.js";
import type { NewsItem } from "../src/providers/news/types.js";

const NOW = Date.parse("2026-09-24T10:00:00+09:00");
const item = (title: string, daysAgo = 1, source = "한국경제", summary: string | null = null): NewsItem => ({ title, url: `https://x/${encodeURIComponent(title)}`, source, publishedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(), summary });
const keep = (stock: { code: string; name: string }, items: NewsItem[]) => filterNews(stock, items, NOW).map((x) => x.title);

describe("종목 뉴스 관련도 (3-12, 운영에서 뽑은 제목)", () => {
  it("RTX: 지포스 RTX 기사는 빼고 레이시온(RTX) 주식 기사만", () => {
    const rtx = { code: "RTX", name: "RTX" };
    expect(isAmbiguous(rtx)).toBe(true);
    expect(
      keep(rtx, [
        item("RTX 5090과 DLSS 5로 고전 마인크래프트를 4K 해상도로 즐겨보세요", 0, "GameGPU"),
        item("RTX(RTX), 프랫 앤 휘트니 사장 교체 소식에 저평가 구간일까?", 0, "simplywall.st"),
        item("마이크론, RTX 50용 2GB GDDR7 생산 중단…삼성·SK하이닉스 의존 커지나", 0, "케이벤치"),
        item("엔비디아 RTX 60 시리즈, 내년 아닌 2028년 출시설 확산…메모리 부족 변수", 1, "digitaltoday.co.kr"),
        item("RTX 주가, 미 국방 예산 증액에 강세", 2),
      ]),
    ).toEqual(["RTX(RTX), 프랫 앤 휘트니 사장 교체 소식에 저평가 구간일까?", "RTX 주가, 미 국방 예산 증액에 강세"]);
    expect(newsQuery(rtx)).toBe('"RTX" (주가 OR 주식 OR 실적 OR 배당 OR ETF) when:30d');
  });

  it("이튼: 라이튼·이튼튼·이튼 메스는 빼고 이튼(ETN)·이튼 실적 기사만", () => {
    const etn = { code: "ETN", name: "이튼" };
    expect(
      keep(etn, [
        item("에이튼이 가져다준 행운? 레이커스가 깜짝 선물을 받았다", 0),
        item("모빌리티 분사 계획이 이튼(ETN)의 투자 매력도를 바꾸고 있는가?", 0, "simplywall.st"),
        item("박준우 셰프의 이튼 메스, 바닐라 대신 오향분과 화자오 넣은 이유", 0),
        item("고양시 일산서구보건소, 초등학생 대상 '이튼튼 건강치아 성장교실' 운영", 2),
        item("AI 데이터센터가 이끈 실적, 이튼 3년간 매출 100억 달러 추가 확보 목표", 6, "마켓잉크"),
        item("한국판 옥토퍼스 도약 엔라이튼, 국내 첫 가상발전소 IPO 도전", 6),
      ]),
    ).toEqual(["모빌리티 분사 계획이 이튼(ETN)의 투자 매력도를 바꾸고 있는가?", "AI 데이터센터가 이끈 실적, 이튼 3년간 매출 100억 달러 추가 확보 목표"]);
  });

  it("QQQI: 30일 넘은 글·블로그·코인 시세 페이지는 빼고 ETF 기사만", () => {
    const q = { code: "QQQI", name: "QQQI" };
    expect(
      keep(q, [
        item("Invesco QQQ Trust, Series 1 (QQQI) 오늘의 주식 시세, 차트 & 뉴스", 6, "CoinGecko"),
        item("10화 QQQI 배당수익률 14%", 13, "브런치"),
        item("세금 친화적 자본환원 커버드콜 ETF, QQQI와 TUGN이 선두", 83, "Investing.com 한국어"),
        item("월배당 ETF QQQI, 9월 분배금 발표", 3, "머니투데이"),
      ]),
    ).toEqual(["월배당 ETF QQQI, 9월 분배금 발표"]);
  });

  it("NAVER: 네이버 별칭과 조사(네이버서)까지 보고, 무관한 기사는 뺀다", () => {
    const naver = { code: "035420", name: "NAVER" };
    expect(
      keep(naver, [
        item("공항 대기시간·무료주차·특선영화까지…네이버 추석 정보 한곳에", 0, "전자신문"),
        item("1조 유니콘 된 뤼튼, IPO 본격화…내년 예심 청구 목표", 0, "서울경제"),
        item("네이버서 日 맛집 예약 클릭 482%↑", 0),
        item("대형마트 최대 50% 할인… 카드사, 소비자 잡기 '추석 혜택'", 0, "조선비즈"),
      ]),
    ).toEqual(["공항 대기시간·무료주차·특선영화까지…네이버 추석 정보 한곳에", "네이버서 日 맛집 예약 클릭 482%↑"]);
  });

  it("두 글자 국내 종목(기아·농심·KT)은 경계만 맞으면 주식 관련 말이 없어도 남긴다 (리뷰 M1)", () => {
    expect(keep({ code: "030200", name: "KT" }, [item("KT, 추석 맞아 멤버십 혜택 확대"), item("SKT·KT 요금제 개편"), item("KTX 추석 예매")])).toEqual(["KT, 추석 맞아 멤버십 혜택 확대", "SKT·KT 요금제 개편"]);
    expect(keep({ code: "004370", name: "농심" }, [item("농심, 인천공항 라운지 접수"), item("농심켈로그 신제품")])).toEqual(["농심, 인천공항 라운지 접수"]);
    expect(keep({ code: "AAPL", name: "애플" }, [item("애플, 신제품 출시 주기 분산"), item("애플망고 제철")])).toEqual(["애플, 신제품 출시 주기 분산"]);
  });

  it("주식 종류 글자(알파벳 A·버크셔 B)는 떼고, 별칭(구글·메타)도 본다 (리뷰 M2)", () => {
    expect(coreName("알파벳 A")).toBe("알파벳");
    expect(coreName("버크셔 해서웨이 B")).toBe("버크셔 해서웨이");
    expect(keep({ code: "GOOGL", name: "알파벳 A" }, [item("구글, 제미나이 새 모델 공개"), item("알파벳 주가 사상 최고")])).toHaveLength(2);
    expect(keep({ code: "META", name: "메타 플랫폼스" }, [item("메타, AI 안경 판매 호조"), item("메타버스 플랫폼 경쟁")])).toEqual(["메타, AI 안경 판매 호조"]);
    expect(newsQuery({ code: "GOOGL", name: "알파벳 A" })).toBe('"알파벳" when:30d');
  });

  it("이름 뒤 수식어(홀딩스·컴퓨팅·(ADR))는 떼고 찾는다", () => {
    expect(coreName("버티브 홀딩스")).toBe("버티브");
    expect(coreName("윙입푸드(ADR)")).toBe("윙입푸드");
    expect(coreName("리게티 컴퓨팅")).toBe("리게티");
    expect(keep({ code: "VRT", name: "버티브 홀딩스" }, [item("버티브, AI 데이터센터 냉각 수요로 목표가 상향", 1)])).toHaveLength(1);
    expect(newsQuery({ code: "RGTI", name: "리게티 컴퓨팅" })).toBe('"리게티" when:30d');
  });
});
