/* md.js —— 极小 Markdown 渲染器（零依赖，约 150 行）。
 *
 * 为什么要自己写：原版是零第三方依赖。为了"回答要 Markdown 渲染"去引 marked/markdown-it
 * 就意味着要 npm install，现场多一个起不来的风险点。这里只实现**本项目回答里真正用到**的子集：
 *   标题 / 段落 / 无序列表 / 有序列表 / 表格 / 引用块 / 水平线 / 围栏代码块
 *   行内：**粗体** *斜体* `代码` [文字](链接)
 *
 * 🔴 安全：**先转义再拼 HTML**。任何来自 LLM 的 `<script>` 都会被转成 `&lt;script&gt;`。
 *    链接只允许 http/https/相对路径，`javascript:` 一律降级成纯文本。
 * 🔴 定位：本文件**不做任何数值处理** —— 数字在服务端就已定稿（dialog.mjs:verifyAnswer），
 *    这里只负责排版，连四位小数都不会碰。
 */
(function (global) {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* 🔴 2026-10-12 F2 根因修复：把 <br> 交给 esc() 转义 = 页面上显示四个字面字符。
     所以"换行"必须在 esc() **之后**拼，绝不能先拼进字符串再 inline()。
     下面所有拼 <br> 的地方都走 splitBr() + 逐段 inline() + 用真 <br> 连接。 */
  function splitBr(s) {
    return String(s == null ? "" : s).split(/<\s*br\s*\/?\s*>/i);
  }

  /* ---- 行内 ---- */
  function inline(s) {
    var t = esc(s);
    /* 代码优先（内部不再做其它替换） */
    var codes = [];
    t = t.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return "\u0000C" + (codes.length - 1) + "\u0000"; });
    /* 链接：只放行 http/https/相对路径。
       ⚠ 允许 URL 里出现**成对的括号**（`javascript:alert(3)` 就是这种形态）——
         否则正则匹配不上，`[点我](javascript:alert(3))` 会漏出半截裸文本 "点我)"，
         看着像渲染坏了。匹配不到就整段降级成纯文字。 */
    t = t.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))+)\)/g, function (m, txt, href) {
      if (!/^(https?:\/\/|\/|\.\/|#)/i.test(href)) return txt;
      return '<a href="' + href + '" target="_blank" rel="noopener">' + txt + "</a>";
    });
    /* 兜底：任何仍然残留的 markdown 链接语法一律剥成纯文字（不许留半截括号） */
    t = t.replace(/\[([^\]]+)\]\([^)]*\)?/g, "$1");
    /* 粗体：允许内容里含单个 *（例如 `**a*b**`），但不跨行 */
    t = t.replace(/\*\*([^*\n](?:[^*\n]|\*(?!\*))*)\*\*/g, "<strong>$1</strong>");
    /* 斜体：前后不能紧贴字母/星号，避免把 `**粗体**` 的残余吃掉 */
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/\u0000C(\d+)\u0000/g, function (_, i) { return "<code>" + codes[Number(i)] + "</code>"; });
    return t;
  }

  function splitRow(line) {
    var s = String(line).trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (c) { return c.trim(); });
  }
  function isSep(line) { return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line); }

  function render(src) {
    var lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    var out = [], i = 0;
    var listBuf = null;   // {tag:"ul"|"ol", items:[]}

    function flushList() {
      if (!listBuf) return;
      out.push("<" + listBuf.tag + ">" + listBuf.items.map(function (x) { return "<li>" + splitBr(x).map(inline).join("<br>") + "</li>"; }).join("") + "</" + listBuf.tag + ">");
      listBuf = null;
    }

    while (i < lines.length) {
      var line = lines[i];

      /* 围栏代码块 */
      var fence = line.match(/^\s*```\s*([a-z0-9+-]*)\s*$/i);
      if (fence) {
        flushList();
        var buf = []; i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; /* 跳过结束围栏 */
        out.push('<pre class="md-code"><code>' + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }

      /* 空行 */
      if (!line.trim()) { flushList(); i++; continue; }

      /* 水平线 */
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushList(); out.push("<hr>"); i++; continue; }

      /* 标题：## 落在 h3（气泡里已经有 .md 这一层，h1/h2 会过大）。
         映射：## → h3，### → h4，#### → h5，##### / ###### → h6。 */
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushList(); var lv = Math.min(6, h[1].length + 1); out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">"); i++; continue; }

      /* 引用块 */
      if (/^\s*>\s?/.test(line)) {
        flushList();
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<blockquote>" + render(q.join("\n")) + "</blockquote>");
        continue;
      }

      /* 表格 */
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && isSep(lines[i + 1])) {
        flushList();
        var head = splitRow(line);
        var rows = []; i += 2;
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        var t = '<div class="md-table"><table><thead><tr>' + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
        for (var r = 0; r < rows.length; r++) {
          t += "<tr>" + rows[r].map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
        }
        out.push(t + "</tbody></table></div>");
        continue;
      }

      /* 列表（支持一层缩进续行） */
      var ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
      var ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
      if (ul || ol) {
        var tag = ul ? "ul" : "ol";
        var text = ul ? ul[2] : ol[3];
        if (listBuf && listBuf.tag !== tag) flushList();
        if (!listBuf) listBuf = { tag: tag, items: [] };
        listBuf.items.push(text);
        i++;
        continue;
      }

      /* 续行：接到上一个列表项 */
      if (listBuf && /^\s+\S/.test(line)) { listBuf.items[listBuf.items.length - 1] += " " + line.trim(); i++; continue; }

      /* 段落 */
      flushList();
      var pbuf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|>|```|\||[-*+]\s|\d+[.)]\s|-{3,})/.test(lines[i])) { pbuf.push(lines[i]); i++; }
      /* ⚠ 这里的顺序是 F2 的根因：先 inline()（内含 esc()）再拼 <br>。
         反过来写（先 replace(\n→<br>) 再 inline()）会被 esc() 转义成 &lt;br&gt;，
         页面上就露出字面的 <br> —— 那正是用户截图里的现象。 */
      out.push("<p>" + pbuf.map(function (x) { return splitBr(x).map(inline).join("<br>"); }).join("<br>") + "</p>");
    }
    flushList();
    return out.join("\n");
  }

  global.WHMD = { render: render, esc: esc, inline: inline };
  if (typeof module !== "undefined" && module.exports) module.exports = global.WHMD;
})(typeof window !== "undefined" ? window : globalThis);
