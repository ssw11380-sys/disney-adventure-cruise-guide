import { describe, expect, it } from "vitest";
import { coreName, etfAliases, filterNews, isAmbiguous, newsQuery } from "../src/providers/news/relevance.js";
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

  it("두 글자 이하 국내 종목(대상·대교·대덕·선진): 이름 검색 결과는 회사를 가리키는 꼴 + 주식·회사 문맥일 때만 (재검토)", () => {
    const daesang = { code: "001680", name: "대상" };
    // 구글 "대상" 검색에서 실제로 나온 무관 기사들 + 회사 기사
    const found = [
      item("[공시]에코앤드림, 유미코아 대상 177억 전구체 수주"),
      item("NH농협금융, 인도네시아 마야파다 그룹 대상 금융 연수 실시"),
      item("60명의 연수생이 3차 대상 그룹을 위한 국방 및 안보 지식 재교육 과정을 수료했습니다."),
      item("[공시]대봉엘에스,기관투자자 대상 기업설명회 개최"),
      item("주주환원 확대한 신한금융, ‘밸류업 2.0’ 통했다…한국IR대상 최고"),
      item("대상, 3분기 영업이익 12% 증가"),
      item("대상그룹 임세령 부회장 승진"),
      item("㈜대상 청정원, 신제품 출시"),
      item("추석 선물세트 경쟁…CJ·대상·오뚜기 가격 동결"),
      item("대상 확대…청년 월세 지원"),
    ];
    expect(filterNews(daesang, found, NOW, true).map((x) => x.title)).toEqual(["대상, 3분기 영업이익 12% 증가", "대상그룹 임세령 부회장 승진", "㈜대상 청정원, 신제품 출시"]);
    expect(newsQuery(daesang)).toBe('("대상㈜" OR "대상그룹" OR "대상 주가") when:30d');
    // 네이버 종목 뉴스(코드로 묶인 기사)는 이름만 맞으면 남긴다 — 대교 실제 제목
    expect(keep({ code: "019680", name: "대교" }, [item("사업 다각화 속도내는 대교"), item("대교, 유아·초등 저학년 독서 관리 '밀착독서'로 지원"), item("SKT의 미래 AI 전략")])).toHaveLength(2);
    // 지명과 같은 이름(대덕) — 리뷰에서 나온 실제 제목
    const daeduck = { code: "008060", name: "대덕" };
    expect(
      filterNews(daeduck, [item("데이터 정리·분석·코딩까지…AI 활용 넓어지는 대덕 연구현장"), item("대전 소부장 특화단지 대상지, 죽동·대덕·안산 803만㎡ 규모"), item("장흥군의회, 전남형 만원주택 회진·대덕·관산 확대 제안"), item("대덕, 2분기 영업이익 흑자 전환")], NOW, true).map((x) => x.title),
    ).toEqual(["대덕, 2분기 영업이익 흑자 전환"]);
    // 같은 이름의 다른 회사(선진그룹 버스)
    expect(filterNews({ code: "136490", name: "선진" }, [item("현대차, 선진그룹에 수소버스 480대 공급"), item("선진그룹 박성수 회장, ‘사랑의 품앗이’ 성금 100만원 기탁"), item("선진, 사료값 인하에 3분기 실적 개선")], NOW, true)).toHaveLength(1);
    // 두 글자 이름(기아)도 이름 검색에서는 같은 규칙
    expect(filterNews({ code: "000270", name: "기아" }, [item("기아, 3분기 美 판매 신기록에 주가 강세"), item("현대차·기아 EV 사수전"), item("기아 타이거즈 우승")], NOW, true)).toHaveLength(1);
    expect(keep({ code: "000270", name: "기아" }, [item("기아 신차 공개", 1, "네이버 프리미엄콘텐츠")])).toHaveLength(0);
    // 흔한 낱말 이름은 요약문만 맞아서는 안 된다
    expect(keep(daesang, [item("주주환원 확대한 신한금융…한국IR대상 최고", 1, "이코노미스트", "올해 대상 수상 기업은")])).toHaveLength(0);
    // 농심(農心) 기사는 뺀다 — 운영 네이버 종목 뉴스 실제 제목
    expect(keep({ code: "004370", name: "농심" }, [item("들끓는 농심에 ‘농지 강제처분’ 유예"), item("추석 앞두고 '농심' 요동치자 진화나선 청와대"), item("농심 주가 요동"), item("농심, 대한항공 라운지 '라면 라이브러리'에 라면 단독 공급")])).toHaveLength(2);
  });

  it("국내 지수 ETF 는 기초지수 이름(S&P500·나스닥100)으로도 찾고, 도박 스팸은 뺀다 (운영 확인)", () => {
    const spx = { code: "379800", name: "KODEX 미국S&P500" };
    expect(etfAliases(spx)).toEqual(["미국S&P500", "S&P500"]);
    expect(etfAliases({ code: "379810", name: "KODEX 미국나스닥100" })).toEqual(["미국나스닥100", "나스닥100"]);
    expect(etfAliases({ code: "005930", name: "삼성전자" })).toEqual([]);
    expect(newsQuery(spx)).toBe('("S&P500" OR "KODEX 미국S&P500") (지수 OR 증시 OR ETF) when:30d');
    expect(
      filterNews(spx, [item("서학개미 8월 수익률 ‘-’…S&P500 올랐지만, 원화 가치 치솟아"), item("로아 캐릭터 슬롯 24 : 위험 피하기", 1, "Calgary Roughnecks"), item("유로 원 토토 비교 팀 협업 체계적 방법"), item("반도체 ETF 수익률 싹쓸이")], NOW, true).map((x) => x.title),
    ).toEqual(["서학개미 8월 수익률 ‘-’…S&P500 올랐지만, 원화 가치 치솟아"]);
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
