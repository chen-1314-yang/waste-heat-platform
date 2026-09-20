/* 在 node 里跑门控与模型的断言，供 pytest 调用。
   以 JSON 输出结果，pytest 侧只做判断。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

global.window = global;
const ROOT = path.resolve(__dirname, "..", "..");
["src/legacy/hfdata.js", "src/learning/model.js", "src/learning/gates.js"]
  .forEach(function (f) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), "utf8"),
                        { filename: f });
  });

const M = window.WHLAB_MODEL;
const G = window.WHLAB_GATES;

const out = {};
out.domain = M.DOMAIN;
out.baselineAt200 = M.baseline(200);
out.violationsBase = M.monotonicityViolations(null);
out.calibrationSetSize = M.calibrationSetSize();
out.calibrationErrorBase = M.calibrationError(null);
out.carnotAt350 = M.carnot(350);

const baseline = { version: "1.0.0", bias: 0, samples: 0 };

out.g1Baseline = G.run(baseline, baseline, { t: 200 });
out.g4InDomain = G.g4(null, null, { t: 200 });
out.g4OutDomain = G.g4(null, null, { t: 500 });
out.g4BelowDomain = G.g4(null, null, { t: 60 });

const good = { version: "1.0.1", bias: 0.02, samples: 1 };
out.goodUpdate = G.run(good, baseline, { t: 250, observed: 106 });

const bad = { version: "1.0.1", bias: 7.66, samples: 1 };
out.badUpdate = G.run(bad, baseline, { t: 250, observed: 900 });

/* 基准相比实测点偏低，所以正向偏置会改善误差 */
const mildBias = 0.05;
const mild = { version: "1.0.1", bias: mildBias, samples: 1 };
out.mildUpdate = G.run(mild, baseline, { t: 250, observed: 100 });

const extremeBias = 1 - 1.95;
const extreme = { version: "1.0.1", bias: extremeBias, samples: 1 };
out.extremeUpdate = G.run(extreme, baseline, { t: 250, observed: 5 });

process.stdout.write(JSON.stringify(out));
