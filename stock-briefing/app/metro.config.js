// Metro 설정. markdown-it 이 Node 내장 모듈 `punycode` 를 import 하므로 npm 의 punycode 패키지로 연결한다.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  punycode: require.resolve("punycode/"),
};

module.exports = config;
