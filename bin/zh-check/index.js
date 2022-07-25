#!/usr/bin/env node

"use strict";
const program = require("commander");
const utils = require("../utils");
const { loadConfig } = require("../configuration");
const vfs = require("vinyl-fs");
const map = require("map-stream");
const path = require("path");
const fs = require("fs");

function commaSeparatedList(value, split = ",") {
  return value.split(split).filter(item => item);
}

program
  .version(require('../../package.json').version)
  .option("--cwd <path>", "工作目录")
  .option("--root-dir <path>", "国际文本所在的根目录")
  .option(
    "--config <path>",
    "配置文件的路径，没有配置，默认路径是在${cwd}/vve-i18n-cli.config.js"
  )
  .option("--no-config", "是否取配置文件")
  .option(
    "--i18n-file-rules <items>",
    "匹配含有国际化文本的文件规则",
    commaSeparatedList
  )
  .option(
    "--ignore-i18n-file-rules <items>",
    "不匹配含有国际化文本的文件规则",
    commaSeparatedList
  )
  .option(
    "--ignore-pre-geg <items>",
    "被忽略的前缀，是个数组",
    commaSeparatedList
  )
  .option("--i18n-import-for-js <item>", "js相关文件需要引入的国际化文件")
  .option("--js-i18n-func-name <item>", "js相关文件需要使用国际化方法")
  .option("--vue-i18n-func-name <item>", "vue相关文件需要使用的国际化方法")
  .parse(process.argv);

const config = {
  // 工作目录
  cwd: ".",
  // 根目录，国际文本所在的根目录
  rootDir: "src",
  // 配置文件的路径，没有配置，默认路径是在${cwd}/vve-i18n-cli.config.js
  config: undefined,
  // 是否取配置文件
  noConfig: false,
  // 匹配含有国际化文本的文件规则
  i18nFileRules: ["**/*.+(vue)"],
  // 不匹配含有国际化文本的文件规则
  ignoreI18nFileRules: [],
  // 被忽略的前缀
  ignorePreReg: [
    new RegExp("//.+"),
  ],
  // 国际化文本的正则表达式，正则中第一个捕获对象当做国际化文本
  i18nTextRules: [
    /(?:[\$.])t\(['"](.+?)['"]/g
  ],
};

Object.assign(config, program);

const CONFIG_JS_FILENAME = "vve-i18n-cli.config.js";

let absoluteCwd = path.resolve(config.cwd);

// 优先判断是否需要读取文件
if (!config.noConfig) {
  let configFilePath = path.join(absoluteCwd, CONFIG_JS_FILENAME);
  if (config.config) {
    configFilePath = path.resolve(config.config);
  }
  if (fs.existsSync(configFilePath)) {
    const conf = loadConfig(configFilePath);
    if (conf && conf.options && conf.options.zhCheck) {
      Object.assign(config, conf.options.zhCheck, program);
    }
  }
}

// 制定配置文件后，cwd在配置文件中定义，则cwd就需要重新获取
if (!program.cwd) {
  absoluteCwd = path.resolve(config.cwd);
}

const { ignorePreReg, i18nImportForJs, jsI18nFuncName, vueI18nFuncName } = config

const absoluteRootDir = path.resolve(absoluteCwd, config.rootDir);

// 匹配中文字符的正则表达式： [\u4e00-\u9fa5] // https://www.w3cschool.cn/regexp/nck51pqj.html
// 匹配双字节字符(包括汉字在内)：[^\x00-\xff] // https://www.w3cschool.cn/regexp/nck51pqj.html
// (?!\$t\()([^\x00-\xff]+) 不已啥开头
// ([^\x00-\xff]+)
// 匹配中文
const regI18n = new RegExp(/([^\x00-\xff]+)/, "g");

// 左边是否是>
function letfRt (str, startIndex, range = 50) {
  const end = startIndex - range
  for (let i = startIndex; i >= end; i--) {
    if (str.charAt(i) === '>') return true
    if (!str.charAt(i).trim()) continue
    return false
  }
  return false
}
// 右边是否是<
function rightLt (str, startIndex, range = 50) {
  const end = startIndex + range
  for (let i = startIndex; i <= end; i++) {
    if (str.charAt(i) === '<') return true
    if (!str.charAt(i).trim()) continue
    return false
  }
  return false
}
// 是否在 > 之间 <
function betweenRtAndLt (strContent, match, index, range) {
  return letfRt(strContent, index - 1, range) && rightLt(strContent, match.length + index, range)
}

// 获取当前元素所在行之前的元素
function getLinePreText(str, match, index, range = 300) {
  const startIndex = index - 1
  let end = startIndex - range
  for (let i = startIndex; i >= end; i--) {
    if (str.charAt(i) === '\n') {
      end = i
      break;
    }
  }
  return str.slice(end, index)
}

// 获取当前元素所在行之后的元素
function getLineSubfixText(str, match, index, range = 300) {
  const startIndex = match.length + index
  let end = startIndex + range
  for (let i = startIndex; i <= end; i++) {
    if (str.charAt(i) === '\n') {
      end = i
      break;
    }
  }
  return str.slice(startIndex, end)
}

// 判定是否被双斜杆注释包裹
function isWrapByDoubelSlashComment (str, match, index, range = 500) {
  const linePreText = getLinePreText(str, match ,index, range)
  return linePreText.indexOf('//') !== -1
}

const i18nWrapPrefixReg = /t\s*\(\s*$/
// 是否被$t包裹 $t("你好") 识别出来的中文
function isWrapByI18n (str, match, index, range) {
  // const subfixText = getLineSubfixText(str, match, index, range) // 不判断后缀了，直接判定前缀
  // if (subfixText.trim().charAt(0) !== ')') return false
  const linePreText = getLinePreText(str, match ,index, range)
  if (!i18nWrapPrefixReg.test(linePreText.trim())) return false
  return true
}

// 是否被 这个注释包括的 /* 包裹的中文
function isWrapByStartComment (str, match, index, range = 500) {
  const startIndex = index - 1
  let end = startIndex - range
  for (let i = startIndex; (i >= (end -1) || i >= 1); i--) {
    // 如果先遇到*/ 则表示不是被包裹
    if (str.charAt(i - 1) === '*' && str.charAt(i) === '/') {
      return false
    } else if (str.charAt(i - 1) === '/' && str.charAt(i) === '*') {
      return true
    }
  }
  return false
}

// 前缀是否满足要求
function prefixTestReg (reg, str, match, index, range) {
  const linePreText = getLinePreText(str, match ,index, range)
  return new RegExp(reg).test(linePreText.trim())
}

// 查找关闭的花括号关闭的位置
function findClosingBracketMatchIndex(str, pos) {
  if (str[pos] !== '{') {
    throw new Error("No '{' at index " + pos)
  }
  let depth = 1;
  for (let i = pos + 1; i < str.length; i++) {
    switch (str[i]) {
      case '{':
        depth++
        break;
      case '}':
        if (--depth === 0) {
          return i
        }
        break
    }
  }
  return -1
}

// 国际化文本，中文开头，可以包含中文数字.和空格，用户匹配
const i18nContentReg = /(?![{}A-Za-z0-9.©×\-_!, ]+)([^\x00-\xff]|[A-Za-z0-9.©×\-_!, ])+/g
// 判定是否包含中文，用于test
const i18nContenTestReg = /^(?![A-Za-z0-9.©×\-_!, ]+$)([^\x00-\xff]|[A-Za-z0-9.©×\-_!, ])+$/
// 处理template
const templateReg = new RegExp("<template>([\\s\\S]+)<\\/template>", "i")
// 处理script
const scriptReg = new RegExp("<script>([\\s\\S]+)<\\/script>", "i")
// tag的内容正则匹配
const TagContentReg = new RegExp('>((?:[^\x00-\xff]|\w|[0-9{}.A-Za-z\\s])+)<', 'g')
// html start tag匹配正则
const startTagReg = new RegExp(/<(?:[-A-Za-z0-9_]+)((?:\s+[a-zA-Z_:@][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:(?:"[^"]*")|(?:'[^']*')|[^>\s]+))?)*)\s*(?:\/?)>/, 'g')
// 属性的正则
const attrReg = /([@:a-zA-Z_][-a-zA-Z0-9_.]*)(?:\s*=\s*(?:(?:"((?:\\.|[^"'])*)")|(?:'((?:\\.|[^'"])*)')))/g;
// 前后非空白，这里必须是三个字符
const nonPreSubWhiteReg = /\S.+\S/
// 国际化字符串，被单引号或者双引号包裹，内容中文开头
const i18nStrReg = /"((?![{}A-Za-z0-9.©×\-_!, ]+)(?:[^\x00-\xff]|[A-Za-z0-9.©×\-_!, ])+)"|'((?![{}A-Za-z0-9.©×\-_!, ]+)(?:[^\x00-\xff]|[A-Za-z0-9.©×\-_!, ])+)'/g

// 处理<script> 到 export default 中间的内容
const scriptPreReg = new RegExp("script>([\\s\\S]+)(?:export\\s*default)", "i")
// 处理props: {} 中间的中文
const propsReg = new RegExp("props\\s*:[\\s\\n]*{", "i")


function processVueFile (fileContent) {
  const resultArr = []
  let match = scriptPreReg.exec(fileContent)
  if (match) {
    const matchContent = match[1]
    let zhMatch;
    while(zhMatch = i18nStrReg.exec(matchContent)) {
      // 忽略被/* */ 注释的中文
      if (isWrapByStartComment(matchContent, zhMatch[0], zhMatch.index)) {
        continue;
      }
      // 忽略被// 注释的中文
      if (isWrapByDoubelSlashComment(matchContent, zhMatch[0], zhMatch.index)) {
        continue;
      }
      resultArr.push({
        type: 'script-pre',
        text: zhMatch[0].slice(1, zhMatch[0].length - 1), // 去掉引号，只保留中文
      })
      // ``处理
      // props中的 default 默认
      // validator 国际化中文
      // 其他 再想
    }
    let propsMatch = propsReg.exec(fileContent)
    if (propsMatch) {
      // console.log(propsMatch[0])
      const propsStartIndex = propsMatch.index + propsMatch[0].length - 1
      const propsCloseIndex = findClosingBracketMatchIndex(fileContent, propsStartIndex)
      if (propsCloseIndex !== -1) {
        const matchContent = fileContent.slice(propsStartIndex, propsCloseIndex)
        let zhMatch;
        while(zhMatch = i18nStrReg.exec(matchContent)) {
          // 忽略被/* */ 注释的中文
          if (isWrapByStartComment(matchContent, zhMatch[0], zhMatch.index)) {
            continue;
          }
          // 忽略被// 注释的中文
          if (isWrapByDoubelSlashComment(matchContent, zhMatch[0], zhMatch.index)) {
            continue;
          }

          resultArr.push({
            type: 'props',
            text: zhMatch[0].slice(1, zhMatch[0].length - 1), // 去掉引号，只保留中文
          })
        }
      }
    }
  }



}

function run () {
  vfs
  .src(config.i18nFileRules.map(item => path.resolve(absoluteRootDir, item)),{
      ignore: config.ignoreI18nFileRules.map(item => path.resolve(absoluteRootDir, item)),
      dot: false
    }
  )
  .pipe(
    map((file, cb) => {
      console.log('开始解析', file.path)
      const extname = path.extname(file.path)
      let fileContent = file.contents.toString()
      let newFileContent
      if (extname.toLowerCase() === '.vue') {
        newFileContent = processVueFile(fileContent)
      }
      cb()
    })
  )
  .on("end", () => {
    console.log('全部处理完成')
  });
}

run()