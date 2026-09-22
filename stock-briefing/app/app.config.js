// app.json 을 기본으로 쓰고, 빌드 환경(EAS 대시보드의 환경 변수)에서 오는 값만 덧붙인다.
// - GOOGLE_SERVICES_JSON: EAS 의 "file" 타입 환경 변수. google-services.json 을 저장소에 넣지 않고 빌드 때 주입한다.
// - EAS_PROJECT_ID: eas init 을 PC 에서 돌리지 않아도 대시보드에서 만든 프로젝트 ID 를 연결할 수 있다.
module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || config.android?.googleServicesFile;
  const projectId = process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId;
  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    // EAS Update 주소는 프로젝트 ID 를 따라간다
    ...(projectId ? { updates: { ...(config.updates ?? {}), url: `https://u.expo.dev/${projectId}` } } : {}),
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { ...(config.extra?.eas ?? {}), projectId } } : {}),
    },
  };
};
