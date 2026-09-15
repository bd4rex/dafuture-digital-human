[English](COZE_SPEECH_FIX.en.md) · [项目说明](README.md)

# 扣子平台语音播放修复交接

日期：2026-09-15。范围：前端播放与交互；不重新接入平台内置 TTS/ASR，不替换男声音色，不修改平台后端或私有配置。部署由使用者在扣子完成。

## 可以直接交给扣子的要求

> 保留这个项目已经匹配好的扣子内置 TTS、ASR、男声音色、`/api/tts`、`/api/asr` 和相关配置。本次只修数字人前端：播报时允许输入下一题，但不提交、不打断当前音频、不自动切成浏览器语音。请按本说明合并本地已验证的音频生命周期、server provider 和交互绑定，不重新生成旧的全局 keydown 音频解锁或 fallbackToBrowserSpeech。不要用仓库默认的 browser 配置覆盖扣子现有的 server 配置。

## 为什么要定向更新

线上页面与仓库并非完全同一份代码。扣子在仓库基础上增加了 `ServerVoiceInput`、`/api/asr` 和 `/api/tts` 适配，公开配置的两个 provider 均为 `server`；仓库默认仍为 `browser`，没有平台内置语音后端。

故障已在部署页面复现：正式音频播放时只按一个普通字母，无第二次 `/answer` 或 `/api/tts` 请求，却触发文档级 `keydown → unlockServerSpeechAudio → audio.src = data:...`。`data:` 音频被线上 `media-src 'self' blob:` 拦截，随后错误回调调用浏览器语音，造成中断和换声。

不能只锁提交按钮，也不要放宽成 `media-src * data:`；问题是解锁过程抢占正式播放器。播报引擎不可用时也不能偷偷换声音。

## 更新哪些文件

- 仓库 `public/avatar.js`：已加入安全的 `server` 播放实现，保留默认 browser provider。
- 仓库 `server.js`：`media-src 'self' blob:` 允许同源页面创建的音频 Blob；不增加 `data:` 音频权限。
- 扣子项目：使用针对其当前 `public/avatar.js` 生成的修复文件，或定向合并下面三个区域；保留其他代码，尤其 ASR 和配置加载。
- 扣子当前页面已经使用上述 Blob CSP，无需覆盖平台 `server.js`。只在实际部署头缺少 `blob:` 时对 `media-src` 作这一项调整。

不要把仓库的整个 `public/avatar.js` 或 `server.js` 直接覆盖到扣子项目：这会丢失只存在于扣子中的语音识别或后端适配。不要覆盖 `avatar-config.json`、知识库、模型配置、管理员认证和主持词。

## 从扣子当前版本生成补丁

把扣子当前的 `public/avatar.js` 导出到一个文件。在本仓库 `answer-mvp/` 下运行：

```bash
node scripts/patch-coze-speech.mjs /path/to/coze-avatar.js /path/to/avatar.fixed.js
node --check /path/to/avatar.fixed.js
```

脚本从本地 `public/avatar.js` 提取下列已测试区域，保留扣子文件其他部分：

1. `BEGIN SERVER SPEECH LIFECYCLE` 到 `normalizedVoiceName` 前：共享播放器、解锁尝试、按轮次清理、开始/完成/停止。
2. `BEGIN SERVER SPEECH PROVIDER` 到 `requestAnswer` 前：平台 `/api/tts` 请求与播放，不再有 `fallbackToBrowserSpeech`。
3. `bindEvents`：保留可编辑草稿和提交守卫，去掉文档级按键解锁，加入安全的空闲指针/明确提交解锁。

输入文件不会被改写，输出文件必须不存在；锚点缺失、重复或残留旧回退时拒绝生成。该脚本针对本次核验的扣子前端结构；扣子若后来修改了上述区域，须先审阅差异，不能盲目覆盖新增行为。

审阅输出中 `ServerVoiceInput`、`/api/asr` 和配置加载仍保留后，仅替换扣子项目的 `public/avatar.js`，重新构建并部署。若本次提供的 `avatar.js` 修复文件已经是由当前线上副本生成的，可直接使用；如果扣子项目后来有未部署的新改动，先导出最新文件重新生成。

## 必须保留的播放规则

- 空闲用户手势才允许解锁；普通打字没有全局音频副作用。准备合成、准备播放、正式播放以及另一个解锁尝试进行中都禁止重新解锁。
- 使用 50 ms Blob/WAV 静音音频。清理前作废解锁尝试身份，迟到的成功/拒绝不能 `pause/load` 正式音频。真实 `playing` 同样标记已解锁。
- 保持平台接口 `POST /api/tts`，JSON 为 `{text}`；成功响应必须是非空 `audio/*` 二进制。合成请求包含读取音频正文的 30 秒截止，收到音频后另设 8 秒启动截止。
- 只有实际 `playing` 切说话姿态；缓冲恢复的重复 `playing` 不重复上报开始。`ended` 才算完成；播放看门狗至少 60 秒并考虑音频时长。
- 合成失败、音频错误、自动播放拦截和超时都保留文字、释放控件，不切换浏览器语音，不自动发送草稿。`play()` 可以拒绝或延迟完成，不能把发起播放当成已发声。[浏览器播放契约](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
- 主动静音、后台停止/主持接管和控制断线仍可明确取消；中止请求、移除监听、停止音频、释放 Blob URL。迟到的请求正文、Promise 和旧音频事件均不能影响新一轮。

## 验收与边界

自动测试：`npm test` 与 `npm run test:review`；本轮 254/254，通过且无跳过/TODO。新增 9 组服务端播放回归及 2 组扣子补丁保留/拒绝规则测试，已有浏览器语音与 ASR 回归继续执行。

浏览器验证使用独立浏览器会话，仅将它收到的 `/avatar.js` 替换为本地补丁；页面、安全策略、实际 `/answer` 与 `/api/tts` 仍来自扣子部署。这不修改线上代码，也不等于已经部署。普通音频使用浏览器原生播放器，非 speechSynthesis 或模拟播放事件。没有启用真实麦克风。

部署后至少执行：

1. 新开部署链接，发送第一题，等男声音频真正开始。
2. 只在输入框逐字输入下一题，不发送；点击输入框、其他普通区域和测试按钮，当前音频保持连续。
3. 播报期间按 Enter 不新增 `/answer`、`/api/tts`，草稿不清空；麦克风不可开启，四态测试不可抢占。
4. 第一题完整结束后输入控件恢复，第二题由使用者确认发送，不自动排队。
5. 模拟 TTS 500、坏音频或播放拒绝时只保留文字，浏览器 `speechSynthesis.speak` 调用为零；取消后的旧音频不复活。
6. 再确认平台 ASR 正常，男声音色未被更换；在小米 15 的微信与 Chrome 分别测试。桌面 Chromium 的手机尺寸模拟不等于微信真机验收。

GitHub 发布和扣子重新部署均需单独执行；本轮只提供修复代码与交接，不自动操作部署。
