/* decision engine v2.1 -> JS 移植（路径筛选、指标公式、红线照 11_决策内核v2_全温域/decision_core.py）
   ⚠ 与 Python 内核的**一处已知差异**（2026-09-27 证据链体检查出，尚未对齐）：
     排序权重本文件用「AHP 主观权重 + 熵权」按 λ 混合（默认 λ=0.5，界面可调），
     而 Python 内核的 load_weights() 只读 主观权重_AHP，既没有熵权也没有 λ。
     因此同一场景两边排序可能不同。要对齐就二选一：给内核补熵权，或本文件退回单权重。
   红线（v2.1）：供冷/干燥受支持；除湿未单列；外购蒸汽驱动吸收式制冷不设废热回收路径；
   能力圈外不硬推荐；温度包络 25~650℃。 */
window.WHENG = (function () {
  "use strict";

  const PATH_KEYS = ["direct", "whb_steam", "abs_self", "abs_ext", "comp",
    "orc", "steam_pp", "tc_storage", "pcm_storage", "teg",
    "abs_cool", "comp_cool"];
  const DISPLAY = {
    direct: "直接换热",
    whb_steam: "余热锅炉直接产汽",
    abs_self: "吸收式热泵提温（余热自驱动）",
    abs_ext: "吸收式热泵（外购蒸汽驱动）",
    comp: "压缩式热泵提温（电驱动）",
    orc: "ORC 余热发电",
    steam_pp: "高温蒸汽发电（蒸汽朗肯）",
    tc_storage: "热化学储热",
    pcm_storage: "相变储热",
    teg: "TEG 热电发电",
    abs_cool: "吸收式制冷（余热驱动）",
    comp_cool: "电压缩制冷（电驱动）"
  };
  const DEMAND_SET = ["发电", "工艺蒸汽", "供暖·热水", "储热调峰", "供冷", "干燥"];
  const UNSUPPORTED_DEMAND = ["除湿", "除湿/干燥"];
  const CP = { "烟气": 1.1, "热水·冷凝水": 4.2, "工艺液体": 2.5 };

  /* 口径（2026-09-27 体检后写明）：
     能效% —— 各路径含义不同：发电类=热效率、热泵类=COP×100 或一次能源效率、
              直换/锅炉/储热=产出比。台账 §5 已声明"同列比较仅为决策演示"。
     投资  —— 单位是「每 MW 该路径自身的装机产出」（发电=每 MW 电装机、
              产热=每 MW 热装机、制冷=每 MW 冷装机），依据台账 §4 引文
              （ORC 23800 元/kW 装机）。规模修正也按同一容量分档。 */
  const INDICATORS = ["能效%", "投资万元/MW装机", "回收期年", "CO2减排t/年", "政策分", "运行成本万元/MW·年"];
  const DIRECTIONS = ["max", "min", "min", "max", "max", "min"];

  const BASE_INDICATORS = {
    /* 直接换热 150 万元/MW装机。
       口径按本表定义：工程总投资（设备+安装+土建），**不含厂外管网**。

       两条独立推导收敛在 120~200，取中值 150：
       ① 金色漫香苑烟气余热回收（EESIA 案例，金房能源）—— 仅锅炉房内回收、用原有管网：
          总投资 90 万元 ÷ 设计回收能力 ≈0.45 MW（按 2×10 t/h 燃气锅炉排烟 100→37℃
          估算：烟气 6.1 kg/s × 1.05 kJ/kg·K × 63 K ≈ 400 kW，加直接接触式潜热 ≈90 kW）
          → 约 200 万元/MW（含安装）；只算设备 55 万元 → 约 122 万元/MW
       ② 迁安·鑫达钢铁余热暖民（政府环评批复 2018）—— 含 15.3 km 厂外管网与换热站：
          一期 1500 万元 ÷ 4.65 MW = 322.6 万元/MW；扣除管网（直埋保温管按
          1,000~1,500 元/m × 15.3 km ≈ 1,500~2,300 万元）后，回收侧约 65~215 万元/MW

       原值 60（无出处）→ 曾短暂取 340（=迁安完全交付口径，含管网，与本表口径不一致）。
       340 作为"含厂外管网"的完全交付上限登记在边界页。

       诚实性标注：本条口径已匹配，但分母含工程估算（0.45 MW 与管网单价均为估算），
       故仍不计入"完全有出处"，需真实项目同时公开"投资额 + 设计回收能力"才能闭合。 */
    direct: [90, 150, 2.5, 0, 3, 6],
    /* 余热锅炉直接产汽 180 万元/MW装机（原 100，工程估算）。
       2026-09-27 第三轮检索首次拿到"不含汽机/发电机"的真实锅炉岛 EPC 价：
       新疆金盛镁业 2×33000 kVA 硅铁矿热炉余热锅炉系统改造（杭州杭锅中标，2026 年），
       中标 2400.032 万元；招标文件补充文件给出蒸发量——设计工况 17.5 t/h、最大 21 t/h，
       → 137.1 万元/(t/h)（设计）／114.3（最大），含锅炉本体+100~200 m 烟道+
       汽水管道+DCS/配电+安装，主蒸汽减温减压后接入一期母管、不含新建汽机。
       折算：给水 104℃ → 2.5 MPa 饱和蒸汽，Δh≈2 367 kJ/kg → 1 t/h ≈ 0.66 MW_th，
       故 137.1/0.66≈208、114.3/0.66≈173 万元/MW；与"整套发电岛中锅炉约占一半"
       （秦皇岛岛价 204.8 万元/(t/h) → 锅炉侧约 155 万元/MW）交叉，取 180。
       此前用"燃气锅炉 15.9~17 万元/(t/h)"类比得出的"偏高 6 倍"结论已撤回——
       那是含燃烧器的标准化产品，与含尘烟气定制余热锅炉不可比。 */
    /* 余热锅炉能效（能效列）2026-09-27 由 85% 下调为 70%：
       第五轮拿到实测——某钢厂 140 t/h 干熄焦余热锅炉**实测锅炉热效率 67.35%**
       （循环气 900~960→160~180℃，《钢铁》2019），另有焦化高参数余热锅炉
       余热利用率 89.04%（江苏特检院测试）作为上界参照。
       原值 85% 是一般锅炉效率的假设值；含尘烟气 + 积灰 + 低温腐蚀工况下达不到。
       取 70%（实测 67.35% 留一定裕量）。 */
    whb_steam: [70, 180, 3.5, 0, 3, 12],
    /* 吸收式热泵（余热自驱动，即第二类 AHT）247 万元/MW装机（原 150）。
       依据（2026-09-27 外部检索 D5）：宁波大榭石化第二类吸收式热泵项目 2019 年投运，
       总投资 1915.5 万元 / 7.77 MW热 = 2,466 元/kW热（EMC 总承包口径，含土建安装；
       其中核心机组 495 万元 = 637 元/kW热），公开回收期 1.49 年。
       原值 150 来自大连理工成果页的 2000/2004 年项目（1,071~1,220 元/kW热），
       年份较早且为设备+安装口径。 */
    abs_self: [170, 247, 2.7, 0, 4, 20],
    abs_ext: [170, 174, 4.2, 0, 4, 0],
    /* 压缩式热泵 675 万元/MW装机（原 120）：2026-09-27 外部检索取得两个系统化锚点
         · 丹麦区域供热委员会 DBDH（**行业协会报告，成本估算口径**）《Large-Scale Heat Pumps》：5~8 Mio DKK/MW
           → 670~1,070 EUR/kW（供水约 80℃、COP 2.6~3.3）→ 约 5,200~8,300 元/kW热
         · 丹麦能源署工艺加热分册：高温热泵 1.55 MEUR/MW（含设备+安装，温升 80K、
           COP≈2.4、出水 ≤150℃）→ 约 12,000 元/kW热
       本路径工况为提温供热（COP 2.8），落在前者区间，取中值 ~6,750 元/kW热。
       原值 120 万元/MW（=1,200 元/kW）比锚点低 4~10 倍。 */
    comp: [106, 675, 4.2, 0, 4, 186],
    /* 发电类造价基值：2026-09-27 按"多来源取中位"重标（原值见下）。

       蒸汽朗肯 7,000 元/kW：水泥窑余热发电 6,391~8,718 元/kW，6 个来源互证
         （水泥网、南平市政府网、中文期刊等，见 真实数据调研\补检索_外部数据通道复核_20260920.md §4.1）

       ORC 10,700 元/kW：三个可核对来源取中位
         · 8,000 元/kW     ORC 撬装机组（《低温余热回收有机朗肯循环技术》2023）
         · 10,700 元/kW    PyPSA ORC 1376 EUR/kW_el（Tartière & Astolfi 2017）
         · 23,800 元/kW    重庆大学学报 2019（工业锅炉烟气 ORC）
       三个来源口径不同（设备本体/系统模型/工程总投资、撬装 vs MW 级工程），
       差别可达 3 倍；单一取值无论取哪个都站不住，故取中位并在边界页登记区间。

       原值（保留备查）：ORC 23,800 元/kW；蒸汽朗肯 5,500 元/kW（低于中文锚点区间）。 */
    orc: [12.3, 1070, 5.6, 0, 4, 15],
    steam_pp: [25, 700, 4.5, 0, 4, 8],
    /* 储热两条按"元/kWh × 储存时长"重标（2026-09-27 外部检索 D2）：
       国内真 PCM 项目的储能量/充电功率配比为 5.0 h（辽宁邮电 1.4MW/7.04MWh）
       与 6.2 h（天津水游城 4.94MW/30.7MWh），取 5.5 h。
         · 相变储热：200~500 元/kWh（科技导报 2025 表5、Frontiers 2025 双来源互证）
           × 5.5 h → 110~275 万元/MW装机，取中值 165（原 600）
         · 热化学储热：500~1,000 元/kWh（同上综述）× 5.5 h → 275~550，取中值 410（原 900）
       注：热化学储热全球仍处实验室/中试，无带投资额的项目可核（外部检索 D3 确认）。 */
    tc_storage: [70, 410, 10.0, 0, 3, 28],
    pcm_storage: [75, 165, 8.0, 0, 3, 25],
    teg: [5, 1500, 12.0, 0, 2, 8],
    /* 制冷两条的投资基值已于 2026-09-27 换成有出处的锚点（原来是无出处常数）：
       溴化锂吸收式制冷机 1944 元/kW、螺杆式电制冷机 1512 元/kW
       （《溴化锂吸收式制冷机与电制冷空调机组的比较》，百度文库，
       制冷系统费用口径；电力增容另计：吸收式 5~10、螺杆 103~206 元/kW）。
       来源检索记录见 docs\2026-09-27-造价锚点补充检索.md */
    abs_cool: [70, 194, 5.5, 0, 4, 3],
    comp_cool: [190, 151, 4.2, 0, 3, 104]
  };

  /* ---- 直接换热的"负荷率"锚点（2026-09-29，T-3，第八轮 S3 实测）----

     ★ 先钉一条口径：我们的 **90% 不是 ε**（换热器效能 Q/Qmax），而是
       "回收热 ÷ 本模型定义的可回收热"——可回收热里已经含了端差与出口温度约束。
       所以实测 ε **不能直接替换**这个常数（换了就是"一个名字装两个物理量"，
       §11.2 六问里的第 1 条就不通过），它只能提供"低负荷时相对衰减多少"的信息。

    实测（都是同一台设备跨负荷/流量的对照点）：
      · 气-气 **三维热管**（迎面风速 1.0→3.0 m/s、六排管）：ε 0.75 → 0.61
        → **相对 0.813**。原文原句："the upwind speed increased from 1.0 m/s to 3.0 m/s,
        and the heat recovery effectiveness decreased from 75% to 61%"（Buildings 2024, 14(2):355，开放获取）
        ⚠️ 2026-10-05 变更：**原来用的"梅山钢铁板式空预器 0.814→0.734（相对 0.902）"已弃用**——
        经知网读完罗桂梅那篇全文，**该文只有温度与燃耗、通篇没有 ε**，且全项目检索无出处（问题台账 L-12）。
        **用一个查无出处的点不如用一个任何人都能下载核对的点。**
       · 气-液 LNG 蒸汽锅炉省煤器：**5 个负荷点 ε 基本恒定 ≈0.77**（差异落在测量不确定度内）
         → 气-液侧对负荷不敏感（Energy Research 2025）
       · 气-气 矿井热管 4 个现场：η 22.3~56.7%（高湿结露，散得太开 → 只能说明"湿态更差"）

     处置（照 §12.2 分档：只给"带宽 + 边界说明"，**不动名义点值**）：
       名义值仍取 90%（与已交付材料一致，避免为好看而调低对手/抬高自己）；
       气-气在**低负荷**（间歇运行）时取下沿 73.2%（=90×0.813）；气-液不给折减。
       这不是"预测"，是"换一台/换一种负荷曲线可能差这么多"的风险沟通。 */
  const DIRECT_EFF_PCT = 90.0;
  /* 2026-10-05：相对衰减由 0.902（梅山点，出处查无）改为 0.813（三维热管，原文原句已核）。 */
  const DIRECT_GAS_GAS_LOW_LOAD_REL = 0.813;           // 实测相对衰减（0.61/0.75，Buildings 2024）
  const DIRECT_EFF_GAS_GAS_LOW_LOAD = 73.2;            // = 90 × 0.813
  /* 判断这条直换是"气-气"还是"气-液"：需求是干燥/烘干且载体是烟气 → 气-气热风。
     （其余组合：烟气→水/蒸汽、热水→水，都是气-液或液-液，实测显示负荷无关。） */
  function isGasGasDirect(scene) {
    if (!scene) return false;
    const dem = String(scene["需求"] || "");
    const med = String(scene["载体"] || "");
    return (dem.indexOf("干燥") >= 0 || dem.indexOf("烘干") >= 0) && med === "烟气";
  }
  function directEffRange(scene) {
    const gasGas = isGasGasDirect(scene);
    const intermittent = String((scene && scene["连续性"]) || "") === "间歇";
    return {
      mid: DIRECT_EFF_PCT,
      low: gasGas ? DIRECT_EFF_GAS_GAS_LOW_LOAD : DIRECT_EFF_PCT,
      high: DIRECT_EFF_PCT,
      mode: gasGas ? "气-气" : "气-液",
      lowLoad: gasGas && intermittent,
      note: gasGas
        ? "气-气直换：实测同设备 ε 随迎面风速由 1.0 升到 3.0 m/s 时由 75% 降到 61%（相对 0.813，Buildings 2024）；长期低负荷时名义 90% 取下沿 73%"
        : "气-液直换：实测 5 个负荷点 ε 基本恒定 ≈0.77（负荷无关）→ 本常数不折减"
    };
  }

  const SCALE_REP_KW = { "小": 500.0, "中": 3000.0, "大": 10000.0 };
  const SCALE_EXP = { steam_pp: 0.70, orc: 0.85 };
  const SCALE_EXP_DEFAULT = 0.90;

  const COP_I_ABS_SELF = 1.7;
  const COP_II_ABS_SELF = 0.45;
  const COP_H_ABS_EXT = 1.7;
  const COP_C_ABS = 0.7;
  const ABS_COOL_T_MIN = 80.0;
  /* ⚠️ 2026-10-04 注（问题台账 L-9 / L-10）：
     COP_E_COOL = 5.0 现在**只剩"占位默认值"一个作用**——runDecision() 里会用
     `CHILLER_COP = electricChillerCop(scene)` 覆盖它（见下方 chillerCop() 与第 1554 行），
     全部决策与收益计算走的都是那个**随工况变化**的值。
     历史上 5.0 的依据是「GB 19577 **水冷式 3 级下限**」，但经国家标准全文公开系统核实：
     **GB 19577-2015 状态已为"废止"**，现行是 GB 19577-2024《热泵和冷水机组能效限定值及能效等级》
     （2024-04-29 发布、2025-02-01 实施）。因此：
       · **不要再把 5.0 当作对外引用的"能效标准限值"**；
       · 界面原先引用 COP_E_COOL 的两处已改为 electricChillerCop(scene)（2026-10-04）；
       · 若将来需要"标准限值"这个口径，须按 **GB 19577-2024** 重查水冷式各等级限值后再用。 */
  const COP_E_COOL = 5.0;
  /* 电制冷 COP 的温度依赖（2026-09-29 第二批·收口版；数据出处与算术见
     src/engine/chiller_grid.js 的头部注释）：

        COP(T_cond) = 4.82 × exp(−0.02536 × (T_cond − 30)) × 蒸发侧形状比 × 0.85(部分负荷)

     · 4.82：重庆通用 1198 kW 水冷离心机**实测** COP 4.59（7.05℃出水 / 31.96℃进水）
       按统一规则斜率归算到 30℃ 冷凝 → 常规离心机基准（工业存量主流机型）；
       ＝ 4.59 × exp(0.02536 × 1.96) ＝ 4.8239，取 4.82（四舍五入，不再向下取整 → 关闭 L-7）；
     · 0.02536 /K（2.536 %/K）：**实测**冷凝侧敏感度。规则 2026-10-03 钉死后复算三台真机
       （tools/derive_chiller_slope.py：固定蒸发器出水温度、逐行最小二乘 ln(COP)~Tcd、取行中位数）：
       特灵 CGWA101M 28 点 **2.311**、开利 30HK100 25 点 **2.640**、
       螺杆 R22（韩彦斌 2016 表2 全 6 点）**2.656** %/K → 均值 **2.536**。
       **2026-10-06 已把规则值落进引擎**（旧 0.0246 是逐来源旧口径 2.35/2.50/2.53 的均值，
       与规则值差 +3.1%）。⚠ 改 k 必须与归算基准同时改，否则两条互相抵消（守则 §12.2 第②档攒批原因）；
       机器间离散 2.311~2.656 记在 chiller_grid.js 的 condSensPerKLow/High，仅供扰动参考。
     · 蒸发侧形状比：ASHRAE 205 合成网格在 (出水温度) 与 (7℃) 两处的比值
       —— 用"比值"是为了消掉网格的绝对水平误差（网格冷凝方向斜率只有 0.6 %/K、
       且最高一档非单调，故冷凝方向一律不采用网格）；
     · 0.85：部分负荷折减（第七轮 R4-C1/C2 实测：57% 负荷 ≈0.80 倍）。

     历史对照：最早固定 5.0（= 假设全年 25℃），上一版改卡诺近似（η=0.41）。
     2026-10-06 重标后：25℃ 环境 额定 4.82 / 有效 4.10；**35℃ 环境 有效 3.18**
     （重标前为 4.80/4.08、3.19）——温度敏感性陡是本版的主要特征。
     机器等级带宽：常规离心 4.82 ↔ 高端磁浮 6.44（×1.336），走决策证书扰动项。 */
  const CHILLER_REF_COP = 4.82;
  const CHILLER_REF_T_COND = 30.0;
  const CHILLER_COND_SENS = 0.02536;
  const CHILLER_CLASS_LOW = 4.82, CHILLER_CLASS_HIGH = 6.44;
  const CHILLER_ETA_CARNOT = 0.41;
  const CHILLER_EVAP_C = 7.0;
  const CHILLER_APPROACH_K = 5.0;
  /* 电制冷的**部分负荷折减**（2026-09-29，A4，第七轮 R4-C1/C2）：
     实测：某 1753 kW 离心机满负荷 COP 6.0~6.5，约 57% 负荷时 4.8~5.2（≈0.80 倍），
     约 28% 负荷时 3.5~4.0（≈0.60 倍）；另一台螺杆机负荷从 100% 降到 63% 时 COP 下降 >35%。
     我们的场景没有负荷率输入，故按"常年平均负荷率约 60~70%"取折减系数 **0.85**（可调）。
     这一步会让"电制冷基准"更贴近真实，从而让吸收式制冷的相对优势回到合理量级。 */
  const CHILLER_PART_LOAD = 0.85;
  /* ASHRAE 205 网格插值（合成骨架）。超出网格范围（冷水出水 2.2~21.1℃ /
     冷却水进水 12.8~46.1℃）按边界值，不外推。 */
  function chillerCopFromGrid(tChwOut, tCondIn) {
    const G = window.WHCHILLER;
    if (!G) return null;
    const xs = G.tChwOutC, ys = G.tCondInC, m = G.cop;
    const clampIdx = (arr, v) => {
      let i = 0;
      while (i < arr.length - 1 && v > arr[i + 1]) i++;
      return i;
    };
    const lerp = (a, b, f) => a + (b - a) * f;
    const i = clampIdx(xs, tChwOut), j = clampIdx(ys, tCondIn);
    const i2 = Math.min(i + 1, xs.length - 1), j2 = Math.min(j + 1, ys.length - 1);
    const fx = xs[i2] > xs[i] ? Math.min(Math.max((tChwOut - xs[i]) / (xs[i2] - xs[i]), 0), 1) : 0;
    const fy = ys[j2] > ys[j] ? Math.min(Math.max((tCondIn - ys[j]) / (ys[j2] - ys[j]), 0), 1) : 0;
    const c = lerp(lerp(m[i][j], m[i2][j], fx), lerp(m[i][j2], m[i2][j2], fx), fy);
    return c;
  }
  /* 蒸发侧形状比（网格只在这里被使用）：网格绝对水平与冷凝方向都不可信，
     但两者之比可以把"绝对水平"消掉；冷凝方向仍然走实测斜率。 */
  function chillerEvapShapeFactor(tChwOut, tCondIn) {
    const a = chillerCopFromGrid(tChwOut, tCondIn);
    const b = chillerCopFromGrid(CHILLER_EVAP_C, tCondIn);
    if (a === null || b === null || !(b > 0)) return 1.0;
    return clamp(a / b, 0.6, 1.6);
  }
  /* 电制冷机的**整机等级**缩放（默认 1.0 = 常规离心机基准 4.80）：
 只给决策证书的扰动测试用（1.0 → 6.44/4.82 = 1.336 表示"换成高端机情景"）。 */
  function chillerClassScale() {
    const v = Number(PRICES.chillerClass);
    return (v > 0) ? v : 1.0;
  }
  function electricChillerCop(scene) {
    const tAmb = Number(ambientC());
    const tCond = (scene && Number(scene["环境温度_degC"])) ? Number(scene["环境温度_degC"]) + CHILLER_APPROACH_K
      : tAmb + CHILLER_APPROACH_K;
    const rated = CHILLER_REF_COP * chillerClassScale()
      * Math.exp(-CHILLER_COND_SENS * (tCond - CHILLER_REF_T_COND))
      * chillerEvapShapeFactor(CHILLER_EVAP_C, tCond);
    return clamp(rated, 1.6, 14.0) * CHILLER_PART_LOAD;
  }
  /* 机器等级带宽（有效值口径，含部分负荷折减）——用于界面的风险沟通与决策证书。
low = 常规离心机（基准 4.82）、high = 高端机**情景值** 6.44（依据待标定）。 */
  function electricChillerCopBand(scene) {
    const mid = electricChillerCop(scene);
    const lo = mid * (CHILLER_CLASS_LOW / CHILLER_REF_COP);
    const hi = mid * (CHILLER_CLASS_HIGH / CHILLER_REF_COP);
    return { mid: mid, low: lo, high: hi,
    note: "机器等级带宽：常规离心机 ↔ 高端磁浮变频机（情景值 ×1.336；**高端端依据待标定**）" };
  }
  /* 当前场景下的电制冷 COP（由 buildMatrixV2 每轮设置，供各公式读取） */
  let CHILLER_COP = COP_E_COOL;
  function chillerCop() { return CHILLER_COP; }
  const STEAM_PRICE = 100.0;
  const STEAM_OPS_FACTOR = 1.03;
  /* ---- 经济性口径（2026-09-27 定稿，对应证据链体检第 2 条）----
     ELEC_PRICE 0.65 元/kWh 的口径是「自发自用、替代企业购电」，不是上网价
     （上网价约 0.40 元/kWh）。若按余电上网计，必须显式改这个常数。
     GAS_PRICE 98 元/GJ 的口径是「替代天然气」，台账 §3 已声明为演示价。
     运维费率：发电/换热/储热 4%/年，热泵与制冷机组 5%/年（工程惯例）。 */
  const OPEX_RATE = { comp: 0.05, comp_cool: 0.05, abs_self: 0.05, abs_ext: 0.05 };
  const OPEX_RATE_DEFAULT = 0.04;

  /* 电加热（电极/电阻锅炉、电热风）效率：用于储热"峰谷套利"口径的价值折算
     （替代峰段电加热时，1 kWh 热需要 1/0.95 kWh 电）。工程取值，已登记。 */
  const ELEC_HEAT_ETA = 0.95;

  /* 技术成熟度门槛（2026-09-27 新增）：TRL < 6 的路径不进推荐池。
     起因：热化学储热经两轮检索确认——全球仍在实验室/中试（TRL 3~5），
     不存在带投资额的项目，所以它不该和已商业化路径同表比经济性，
     继续找数据也没有意义（不是渠道问题，是产业阶段问题）。
     其余路径的成熟度依据：ORC／蒸汽朗肯／直接换热／余热锅炉／压缩式热泵／
     制冷两条＝9（在运工程多）；TEG＝8（2.5 MW 级商品在售）；
     相变储热＝8（国内多个商业项目在运：辽宁邮电、天津水游城、西安高新等）。 */
  const TRL_MIN = 6;
  const TRL = {
    orc: 9, steam_pp: 9, direct: 9, whb_steam: 9, comp: 9,
    abs_self: 8, abs_ext: 8, abs_cool: 9, comp_cool: 9,
    teg: 8, pcm_storage: 8, tc_storage: 4
  };
  function trlOk(p) {
    const v = TRL[p] === undefined ? 9 : TRL[p];
    return v >= TRL_MIN;
  }

  /* 供暖·热水的季节性折算（2026-09-27 外部检索，E1 项）。
     供暖不是全年用热：收益与减排必须按"供暖季等效满负荷小时"计，不能按 8,000 h。
     依据：鄂尔多斯市政供热规划 2,872 h、陕西恒源厂区采暖 3,571 h（外部检索）；
     用台账中哈石化真实工程（174 万元/MW、回收期 4.2 年）反推约 1,300~1,500 h
     （偏低端，可能含负荷率折减）。取 3,200 h 为默认上限：
     即用户填的 8,000 h 会被折算成 3,200 h，用户填更小的值则原样保留。 */
  const HEATING_SEASON_HOURS = 3200;

  /* ⚠ 非供暖需求的默认年运行小时由 8,000 → 7,000（2026-09-27）→ **6,500（2026-09-29）**。
     依据：现在有 **6 个真实项目**的等效满负荷小时（用逐月/年度净发电量 ÷ 装机算）：
       3,313（CDM 1717 山西中化寰达 24 MW 焦炉余热，17 个月逐月）
       3,481（CDM 3135 宁夏赛马 24 MW，32 个月逐月）
       5,700（海南炼化 1.34 MW，全年发电量 ÷ 铭牌 8352 h）
       6,492（三狮水泥，年发电 6,426.9 万 kWh ÷ 平均能力 9,900 kW）
       7,083（CDM 1674 建德海螺 8.3 MW，2010 年逐月净供电 58,787.91 MWh ÷ 8.3 MW）
       8,000（衢州元立 KE100，2.5 年净发电 200 万 kWh）
     中位 ≈ 6,100 h、区间 3,313~8,000 h。取 **6,500** 作默认（比中位略乐观，
     比原来的 7,000 保守），并在界面上写明区间与六个实测点。 */
  const DEFAULT_RUN_HOURS = 6500;
  /* 可调参数（2026-09-27 做成界面参数，供"换地区/换计价方式"现场演示）。
     默认值与出处见上；setPrices() 由界面调用，只影响之后的计算。 */
  /* heatPrice（元/GJ）：产热类路径的收益单价。默认 98＝台账 §3 的"替代天然气"口径；
     但工艺蒸汽场景实际替代的是**蒸汽**，台账 §4 记：工业低压蒸汽上沿约 100、
     2024 行业市场均价 39.7 元/GJ —— 两者差 2.5 倍，直接决定产汽路径的回收期
     （余热锅炉按 98 算 0.6 年、按 40 算约 1.7 年）。
     因此不硬改默认值，而是做成可调参数，并在边界页写明敏感性。 */
  /* valleyElec（元/kWh）：谷段电价，用于电蓄热类储热路径的充电成本。
     依据：第三轮检索拿到分省峰谷电价——山东 2025-04 一般工商业 35 kV：
     深谷 0.25、低谷 0.35、平 0.71、高峰 1.00、尖峰 1.20 元/kWh（尖峰−深谷 0.95）。
     取低谷 0.35 作为默认充电电价。 */
  /* 电价默认值 2026-09-27 由 0.65 调整为 0.68：
     第四轮检索取得 7 省官方代理购电工商业到户电价（两部制 1-10kV 平段、
     含购电+线损+输配电价+系统运行+基金附加，均可逐项加总复核）——
     浙江 0.6101、湖北 0.6273、上海 0.6407、江苏 0.6756、四川 0.6864、
     河南 0.6943、广东珠三角 0.7068；连同已有的安徽 0.6844、山东 0.71 共 9 省，
     中位数 0.6844 ≈ 0.68，区间 0.55~0.72。原默认 0.65 取两省偏保守值，
     现按 9 省中位取 0.68（界面仍可调 0.30~0.80）。 */
  let PRICES = { elec: 0.68, heatingHours: HEATING_SEASON_HOURS,
                 heatPrice: 98.0, valleyElec: 0.35,
                 /* 峰谷价差（元/kWh）与储热口径参数，2026-09-28 新增（P1-4/P1-5）。
                    峰谷价差默认 0.95 元/kWh：第二轮外部检索拿到 11 省分时电价价差
                    （山东 0.95、浙江 1.35/1.40、广东珠三角 1.35、上海 1.65、湖南 1.61、
                     江苏 0.92、四川 0.81、河南 0.75、北京 0.54、福建 0.52），
                    去掉重复项后中位约 0.94，取山东值 0.95 作默认。 */
                 peakValley: 0.95,
                 /* ORC 设计降温程（源侧被冷却 K），2026-09-28 做成可调参数（P2-9）。
                    默认 46.5 K＝两条可用工业实测锚点的中位（海南炼化 48、AKCA 45；
                    燕山石化那条 65 K 因数据自身不成立已被剔除，见 ORC_COOLDOWN_K 注释）。 */
                 orcCooldown: 46.5,
                 /* 环境温度（℃）——2026-09-28 新增：两级/串级 ORC 的冷凝温度由它决定
                    （T_cond = 环境 + 5 K 的 approach，见 tools/two_stage_orc.py 标定）。
                    默认 25℃（中国工业区年均环境温度的常见取值）。 */
                 ambient: 25.0,
                 /* 供热/供汽系统的输配电耗（kWh 电 / GJ 热）——2026-09-28 第六轮 N4。
                    证据：设计良好网 1~2%（≈2.8~5.6 kWh/GJ，AGFW FW524/Europump 口径）；
                    国内热力站实测均值 **3.43 kWh/GJ**（≈1.23%，清华《中国建筑节能年度发展
                    研究报告 2020》行业统计）；含热源风机/泵综合约 5~6 kWh/GJ（DB11/T 1150
                    准入值）。默认取实测均值 3.43，只作用于产热类路径。 */
                 heatAuxKwhGj: 3.43,
                 /* 扰动开关（只给"决策证书"用，默认 1.0 = 不缩放）：
                    effScale 缩放发电类效率与热泵 COP；investScale 缩放投资列；
chillerClass 缩放电制冷基准 COP（1.0 = 常规离心机 4.82，
                    1.34 = 高端磁浮变频机 6.44，见 chiller_grid.js）。 */
                 effScale: 1.0,
                 investScale: 1.0,
                 chillerClass: 1.0,
                /* 2026-10-09 新增：三项"工程取值/边界"从硬编码变成可扰动参数
                   （证书里逐项扰动，看推荐会不会翻）：
                     steamBoundC       蒸汽朗肯候选边界温度℃（默认 280，数据边界）
                     steamEtaCapScale  蒸汽轮机容量效率的额外缩放（1.0=主值）
                     genEtaScale       发电机+机械效率缩放（MW 级 0.95~0.97 是工程取值） */
                steamBoundC: 280.0,
                steamEtaCapScale: 1.0,
                genEtaScale: 1.0,
                steamExhaustFloorC: 150.0,
                liquidFloorC: 40.0,
                 /* 储热收益口径："heat"＝售热（替代燃料，原口径）、
                    "arbitrage"＝峰谷套利（替代峰段电加热）、"stack"＝两者叠加（见注意事项）、
                    "off"＝不计收益（只做技术展示）。 */
                 storageMode: "heat",
                 /* 充热方式："valley"＝谷电充热（要付谷段电费与效率损失）、
                    "waste"＝余热直接充热（充热本身不花钱，只忽略泵电耗）。
                    默认 "waste"：本平台的场景前提是"用回收的余热充热"；
                    工况库那行"电加热熔盐（谷电充热）"属于前者，评价该行时请切换。 */
                 storageCharge: "waste",
                 /* 峰段等效满功率放电小时：按每天 4~5 h 峰段计，全年约 1,500 h。
                    为什么不能沿用工况库的 6,000 h：那是"余热可用小时"，
                    而储热的年吞吐量取决于**峰段时长×每日循环次数**。 */
                 storageHours: 1500 };
  function setPrices(p) {
    if (!p) return;
    if (p.elec > 0) PRICES.elec = Number(p.elec);
    if (p.heatingHours > 0) PRICES.heatingHours = Number(p.heatingHours);
    if (p.heatPrice > 0) PRICES.heatPrice = Number(p.heatPrice);
    if (p.valleyElec > 0) PRICES.valleyElec = Number(p.valleyElec);
    if (p.peakValley >= 0) PRICES.peakValley = Number(p.peakValley);
    if (p.storageHours > 0) PRICES.storageHours = Number(p.storageHours);
    if (p.storageMode && ["heat", "arbitrage", "stack", "off"].indexOf(p.storageMode) >= 0) {
      PRICES.storageMode = p.storageMode;
    }
    if (p.storageCharge && ["valley", "waste"].indexOf(p.storageCharge) >= 0) {
      PRICES.storageCharge = p.storageCharge;
    }
    if (p.orcCooldown > 0) PRICES.orcCooldown = Number(p.orcCooldown);
    if (p.ambient > -20) PRICES.ambient = Number(p.ambient);
    if (p.heatAuxKwhGj >= 0) PRICES.heatAuxKwhGj = Number(p.heatAuxKwhGj);
    if (p.effScale > 0) PRICES.effScale = Number(p.effScale);
    if (p.investScale > 0) PRICES.investScale = Number(p.investScale);
    if (p.chillerClass > 0) PRICES.chillerClass = Number(p.chillerClass);
    if (p.steamBoundC > 0) PRICES.steamBoundC = Number(p.steamBoundC);
    if (p.steamEtaCapScale > 0) PRICES.steamEtaCapScale = Number(p.steamEtaCapScale);
    if (p.genEtaScale > 0) PRICES.genEtaScale = Number(p.genEtaScale);
    if (p.steamExhaustFloorC > 0) PRICES.steamExhaustFloorC = Number(p.steamExhaustFloorC);
    if (p.liquidFloorC > 0) PRICES.liquidFloorC = Number(p.liquidFloorC);
  }
  function elecPrice() { return PRICES.elec; }
  function heatingHoursCap() { return PRICES.heatingHours; }
  function heatPrice() { return PRICES.heatPrice; }
  function valleyElec() { return PRICES.valleyElec; }
  function peakValley() { return PRICES.peakValley; }
  function storageRevenueMode() { return PRICES.storageMode; }
  function storageChargeMode() { return PRICES.storageCharge; }
  function orcCooldownK() { return PRICES.orcCooldown; }
  function ambientC() { return PRICES.ambient; }
  function heatTransportKwhGj() {
    return PRICES.heatAuxKwhGj === undefined ? 3.43 : PRICES.heatAuxKwhGj;
  }
  /* 干燥（热风系统）的电耗占比（2026-09-29 第七轮 R4-D1）：
     匈牙利锯木厂 6 台对流热风干燥窑的**工业现场高分辨率实测**（CC-BY）：
     6 台风机 ×(3~4 kW)=18~24 kW/窑，**电占总能耗约 12%**（热 88% / 电 12%）。
     而输配循环泵口径只有 1.23%（3.43 kWh/GJ）——干燥是**风机主导**，
     用泵口径会把风机电耗低估约 10 倍。故干燥单独取 12% 折算：
     12% × 277.78 kWh/GJ = 33.33 kWh 电 / GJ 热。 */
  const DRYING_ELEC_SHARE = 0.12;
  const KWH_PER_GJ = 277.7778;
  function dryingTransportKwhGj() {
    return DRYING_ELEC_SHARE * KWH_PER_GJ;
  }
  /* 按需求类型取"把热送到用户/工件"的电耗单价（kWh 电 / GJ 热） */
  function transportKwhGjFor(demand) {
    if (demand === "干燥") return dryingTransportKwhGj();
    return heatTransportKwhGj();
  }
  /* 输送一份热量所产生的电耗（kWh）与对应排放（tCO2） */
  function heatTransportKwh(qKw, hours) {
    const gj = Number(qKw) * Number(hours) * 3.6 / 1000.0;
    return gj * heatTransportKwhGj();
  }
  function heatTransportCo2(qKw, hours, demand) {
    const gj = Number(qKw) * Number(hours) * 3.6 / 1000.0;
    return gj * transportKwhGjFor(demand) * GRID_EF / 1000.0;
  }
  /* 储热的年等效满功率放电小时（不超过用户填的年运行小时） */
  function storageHoursOf(hours) {
    const h = Number(hours);
    const cap = PRICES.storageHours;
    if (!(h > 0)) return cap;
    return Math.min(h, cap);
  }

  /* 经济性标定状态。为什么要分级：台账 §5 自己写明——
     直接换热/余热锅炉的投资回收期是"工程估算"，储热/TEG 是"示意"。
     这类数字不该决定排序，所以在 TOPSIS 里按中性计入（不奖不罚），
     界面上也标出来。只有有可核对出处的路径才用统一公式现算。 */
  const ECON_GRADE = {
    orc: "sourced",        // 公式现算 5.60 年，与台账引文（重庆大学学报 2019：5.58 年）吻合
    steam_pp: "sourced",   // 公式现算；水泥窑行业典型 2~3 年（见文档说明）
    abs_ext: "sourced",    // 哈石化"余热暖民"真实工程：174 万元/MW、回收期 4.2 年
    abs_cool: "sourced",   // 投资锚点：溴化锂机组 1944 元/kW（2026-09-27 补检索）；
                           // 回收期由公式现算（省电价值 − 运维）
    abs_self: "sourced",   // 投资锚点：大榭石化第二类 AHT 2019 年项目 2,466 元/kW热
                           // （EMC 含土建安装，7.77 MW、1915.5 万元、公开回收期 1.49 年）
    teg: "sourced",        // 投资锚点：2.5 MW 级售价约 2,200 USD/kW≈15,800 元/kW
                           // （2026-09-27 检索 D4，与原有综述下界 15,000 元/kW 互证）；
                           // 公式现算回收期 3.3 年，落在文献测算区间 3.7~5.4 年内
    whb_steam: "sourced",  // 投资锚点：金盛镁业锅炉岛 EPC 137.1 万元/(t/h)（不含汽机/发电机），
                           // 折算并与"整套岛中锅炉约占一半"交叉后取 180 万元/MW装机
    /* 压缩式热泵 2026-09-27 改为 sourced（新网站按全新自洽口径，不再向旧文献让步）：
       此前投资用 DBDH/DEA 锚点（675 万元/MW），回收期却用另一篇文献的 4.23 年——
       两者不可比。改为按公式现算后得：
         · 供暖·热水（3,200 季节性小时）：收入 112.9、自耗电 37.8、运维 33.8 → 回收期 ≈16 年
         · 干燥（6,000 h、COP 4.2）：回收期 ≈8 年
       与文献 4.23 年的差异不是算错，而是**场景不同**：文献那类数字对应全年运行的
       工艺用热（8,000 h 量级），而供暖是季节性用热（3,200 h，见 E1 项）。
       换算验证：若要 4.23 年回收，需年净收益约 160 万元/MW，在 3,200 h 下要求
       投资降到 ~200 万元/MW —— 与 DBDH 锚点（5,200~8,300 元/kW）差 3 倍，
       说明"低投资 + 快回收"的组合不成立，两个数字里必然有一个口径不对。 */
    comp: "sourced",
    comp_cool: "pending",  // 投资已换成螺杆机组锚点 1512 元/kW，但它是"电驱动基准"路径、
                           // 不构成改造投资回收问题，故回收期不做现算
    /* 直接换热 2026-09-27 升级为 sourced（新网站按全新自洽口径）：
       投资 150 万元/MW 现有三条独立佐证——金色漫香苑（锅炉房内回收，不含外网）、
       迁安（含 15.3 km 外网，作上限）、葫芦岛工业余热暖民工程（总投资 13 500 万元
       ÷ 设计热负荷 79.04 MW = 171 万元/MW，真实项目同时给出投资与设计负荷）。
       回收期改公式现算：供暖·热水按 3,200 季节性小时、热价 98 元/GJ 时约 1.4 年。
       对照：金色漫香苑项目自报回收期 3.2 个采暖季——差异来自该项目含改造范围更宽
       与负荷率折减，登记为对照点而非改用值。 */
    direct: "sourced",
    tc_storage: "pending", // 台账 §5："示意"
    /* 相变储热 2026-09-28 由 pending 升为 sourced（P1-4）：
       此前卡住的两件事现在都有了明确口径——
       ① 投资：165 万元/MW装机 = 200~500 元/kWh（科技导报 2025 表 5 + Frontiers 2025
          双来源）× 国内真 PCM 项目 5.5 h 储能量/充电功率配比；
       ② 收益：三套可选口径都已写成显式公式（售热 / 峰谷套利 / 叠加），
          年吞吐量按"峰段等效放电小时"，充热方式（谷电/余热）也做成参数。
       口径本身是场景选择，不是市场观测值 —— 这一点写在边界页与界面上。 */
    pcm_storage: "sourced",
  };
  const GRID_EF = 0.581;
  const GAS_EF = 0.0561;
  const BOILER_EFF = 0.90;
  const ELEC_PRICE = 0.65;
  const HP_COP = 2.8;
  const GAS_PRICE = 98.0; // 元/GJ（替代天然气演示价，展示口径）

  let TABLES = null; // { orcPct, stCurve } 由 data.js 注入

  function setTables(t) { TABLES = t; }

  function pyRound(v, nd) {
    if (v === null || v === undefined || isNaN(v)) return v;
    const f = Math.pow(10, nd);
    return Math.round((v + 1e-9) * f) / f;
  }

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function validateScene(scene) {
    const s = Object.assign({}, scene);
    if (s["需求温度_degC"] === undefined || s["需求温度_degC"] === null) s["需求温度_degC"] = null;
    if (s["连续性"] === undefined || s["连续性"] === null) s["连续性"] = "连续";
    if (s["驱动来源"] === undefined || s["驱动来源"] === null) s["驱动来源"] = "余热自驱动";
    if (s["年运行小时"] === undefined || s["年运行小时"] === null) {
      s["年运行小时"] = DEFAULT_RUN_HOURS;      // 6,500 h（6 个真实项目中位≈6,100）
    }
    if (s["换热端差_degC"] === undefined || s["换热端差_degC"] === null) s["换热端差_degC"] = 10;
    if (s["规模_kW"] === undefined || s["规模_kW"] === null) s["规模_kW"] = null;
    if (s["流量_kg_s"] === undefined || s["流量_kg_s"] === null) s["流量_kg_s"] = null;
    /* 2026-10-11（C 类体检）：**载体必须在最外层拒掉**。
       以前传 "蒸汽" 也会 ok:true，异常要等到很深的 cpOf 才抛——
       正是"最外层说通过、真拒绝在深处"那一类（DSH 硬审计报的）。 */
    if (CP[s["载体"]] === undefined) {
      return { ok: false, error: "未知的载体：" + s["载体"] +
        "（可用值：" + Object.keys(CP).join(" / ") + "）" };
    }
    const demand = s["需求"];
    if (UNSUPPORTED_DEMAND.indexOf(demand) >= 0) {
      return { ok: false, error: "需求「" + demand + "」未单列为 v2 需求类型：除湿并入供冷/干燥场景后评价，模型无法单独评价。" };
    }
    if (DEMAND_SET.indexOf(demand) < 0) {
      return { ok: false, error: "未知需求类型：" + demand };
    }
    const t = Number(s["热源温度_degC"]);
    if (!(25 <= t && t <= 650)) {
      const extra = t > 650 ? "；高于 650℃ 的发电/产汽需多压/再热锅炉专项设计" : "；低于 25℃ 需额外驱动能投入，不做评价";
      return { ok: false, error: "热源 " + t + "℃ 超出 v2 标定包络（25~650℃）" + extra };
    }
    s["热源温度_degC"] = t;
    /* 供暖·热水按供暖季等效小时折算（见 HEATING_SEASON_HOURS 说明）。
       原值存进 年运行小时_原值，便于界面说明"表里用的是折算后的小时数"。 */
    if (s["需求"] === "供暖·热水") {
      const h0 = Number(s["年运行小时"]);
      if (h0 > heatingHoursCap()) {
        s["年运行小时_原值"] = h0;
        s["年运行小时"] = heatingHoursCap();
      }
    }
    return { ok: true, scene: s };
  }

  function recoveredHeatKw(scene) {
    const m = scene["流量_kg_s"];
    if (m) {
      const dt = Math.max(Number(scene["热源温度_degC"]) - heatFloor(scene) -
                          Number(scene["换热端差_degC"]), 5.0);
      return Number(m) * cpOf(scene["载体"]) * dt;
    }
    const q = scene["规模_kW"];
    if (q) return Number(q);
    throw new Error("缺少流量或规模_kW，无法计算可回收热功率");
  }

  /* 源侧降温下限（2026-09-27 按实测修正，第五轮）。

     旧算法：一律按"冷到 40℃"算可回收热 —— 对用热类路径是**高估**，
     因为热量只能回收到"下游用得上"的温度为止。

     实测证据（三条）：
       · 首钢京唐/迁钢 高炉冲渣水供暖：75℃ → 65℃ 采暖水（**实际只降 10 K**），
         而旧算法按 75−40−端差 = 25 K 算，**高估 2.5 倍**；
       · 金色漫香苑 烟气余热回收：排烟 100 → 37℃（直接接触式，接近降到接近环境）；
       · 燕山石化 S-Zorb（发电，另计）：汽油 135 → 70℃。

     新算法（仅用于**用热类需求**：供暖·热水/工艺蒸汽/干燥/储热调峰）：
        下限 = min(需求温度 + 换热端差, 热源温度 − 10 K)
        —— 前一项是物理约束（送出的热必须高于需求温度并留端差）；
           后一项保证"热源本身高于需求温度"的场景（如热泵驱动的低温余热）
           仍能取出至少 10 K 的温降，而不是被算成 0。

     发电类暂不改：ORC 的取值需要"按路径分别算回收热"（ORC 与蒸汽朗肯的
     降温程不同），属于下一步的重构，已在边界页登记。
     ✅ **2026-10-11 更新：该重构已完成**——见下方 `qForPath()`（ORC/蒸汽/TEG 各有自己的取热函数）。
     上句描述的状态**已不成立**，勿据它判断现状。 */
  const HEAT_MIN_COOLDOWN_K = 10.0;

  /* ---- 发电类的源侧降温设计（2026-09-27 按实测锚点建立）----
     为什么必须按路径分别算：ORC 与蒸汽朗肯的降温程完全不同——
     蒸汽朗肯的余热锅炉可以把烟气一路降到 150℃ 左右（受酸露点限制），
     而单压 ORC 只能把热源降到"蒸发温度 + 端差"。

     ORC 设计温差 ORC_COOLDOWN_K（源侧被冷却多少 K）：
     ★ 2026-09-28 复核（P2-9 / P3-11），原来写"三条实测取 50 K"，现改为两条可用锚点的中位 46.5 K：
       · 海南炼化（开山 2×串级 R245fa）：热水 118→70℃ = **48 K**（可用）；
       · 土耳其 AKCA（Exergy）：卤水 105→60℃ = **45 K**（可用）；
       · 燕山石化 S-Zorb（开山 900 kW）：汽油 135→70℃ = 65 K ——
         **该条数据自身不成立，已从锚点里剔除**：900 kW 净输出 ÷ 5 642 kW 回收热 = 16%，
         而 135→70℃ 的卡诺效率上限只有 11%（16% > 11%，物理上不可能；多半是
         "额定额定值/年均值"或"回收热口径"被混用）。算式见
         docs/2026-09-28-P1批次_精度与口径修正.md 第七节。
       蒸发温度 = clamp(热源温度 − ORC_COOLDOWN_K, 60, 350)；源侧降温下限 = 蒸发温度 + 端差。
     ★ 该值现在是**界面参数**（2026-09-28，P2-9）：设计降温程本质上是"回收热量 vs 蒸发温度"
       的取舍（降温越大 → 回收热越多，但蒸发温度越高、换热器面积与压降也越大），
       真实项目落在 45~65 K。界面可调 30~90 K，并另外给出**功率最优设计点**作对照
       （提示：那个最优点没有计入换热器面积成本，不能直接当作推荐设计）。

     蒸汽朗肯排烟下限 STEAM_EXHAUST_FLOOR_C = 150℃：余热锅炉排烟不可能无限低
       （酸露点 + 经济性）。实测参照：宁国水泥厂 4000 t/d 线的 PH 炉 350→250℃、
       AQC 炉 360→91℃（《水泥》类年报数据）；取 150℃ 作偏保守的典型值。

     ⚠ 低压段/低温宽温差：**这项扩展已经做完了**（2026-10-10 订正——本节原来写着
       "标定范围是异丁烷 p_high 1.8~3.6 MPa、对应蒸发 ≥100℃…已登记为下一步"，那是**过期注释**）：
       · 2026-09-27：一维效率表下探到 **60℃ 蒸发**（`tools/scan_orc_lowtemp.py`，异丁烷低压段 + R245fa，7,550 点）；
       · 2026-09-29：新增**二维表（蒸发×冷凝）**，覆盖 **蒸发 60~150℃ × 冷凝 20~65℃**，工质 `[Isobutane, R245fa]`
         （`tools/orc_cond_table.py` → `src/engine/orc_cond_table.js`）——液体热源按**真实冷源温度**查表，
         取代原来隐含 50~62℃ 的一维表。
       · 原注释引的**燕山石化锚点早已被剔除**（额定 900 kW 隐含热效率 16% > 循环卡诺 8.9%，物理上不成立），
         所以那句"偏低 2.4 倍"**引的是一个已作废的数**。
     ⚠ **剩余的真实偏差（2026-10-10 实测，已定稿）**：低温宽温差锚点 **Chena（82→65℃ 地热）**上，
       产品路径（cond-aware，**按站点 ambient 10℃**）给 **7.66% / 254 kW** vs 实测 **312 kW** → **−18.7%**。
       ⚠ **表述口径（务必照此，2026-10-10 DSH 指出）**：这是「**在适用域下沿偏保守 18.7%**」，
       **不能写成"模型整体偏低 18.7%"**——该点热源仅 82℃，`orcDesignEvapTemp` 被**下限 60℃ 夹住**、
       可用跨度只剩 **17 K**，而本表标定档是"蒸发 ≥100℃"、二维表也只到 60℃ 的下边界。
       「边界工况、方向保守」与「模型不准」对评委是两件完全不同的事。
       ⚠ 这个数**我先后报错过两次**，都记在这里免得后人重踩：
         ① 先报 **−68%** —— 那是我 10-09 那条 P4 越界校验**写出的回归**（`tc < tcLo` 把 tCond=15℃
            直接拒绝，而旧代码会吸附到表下限 20℃ 用二维表）；**已修**（两侧各留 ±5 吸附余量）。
         ② 再报 **−38%** —— 那是我**探针用错 ambient**（用默认 25℃ 而非脚本按阿拉斯加设的 10℃）得到的。
       → 正确值 **−18.7%**；`anchor_reconciliation.js` 修好越界校验后已复现该值。
       → 这条**总体上已缓解**（−18.7% 远小于旧注释说的"2.4 倍"）；若要继续收紧，
         属"我们自己能跑 CoolProp、把二维表在更低蒸发/更高冷凝处加密"的工作。 */
  const ORC_COOLDOWN_K = 46.5;   // 默认值；运行时用 orcCooldownK() 读取（界面可调）
  const STEAM_EXHAUST_FLOOR_C = 150.0;

  function orcEvapTemp(scene) {
    return orcDesignEvapTemp(Number(scene["热源温度_degC"]),
                             Number(scene["换热端差_degC"]));
  }
  /* 设计蒸发温度 = 热源温度 − 源侧降温程 − 换热端差。
     ★ 2026-09-28 修正口径：orcCooldown 的定义是**源侧被冷却多少 K**
     （实测锚点就是这么量的：海南炼化 118→70℃＝48 K），
     所以蒸发温度必须再减掉换热端差 —— 原来把"热源−蒸发温度"当成了降温程，
     等于让源侧实际只降 (降温程 − 端差)，比锚点少降 10~25 K。 */
  function orcDesignEvapTemp(tSrcC, dTC) {
    return clamp(Number(tSrcC) - orcCooldownK() - Number(dTC), 60.0, 350.0);
  }
  function orcRecoveredKw(scene) {
    const m = Number(scene["流量_kg_s"]);
    if (!m) { const q = Number(scene["规模_kW"]); return q || 0; }
    /* 不可行时不给"虚构可回收热"（2026-10-09，DSH 复核 P5） */
    if (!orcFeasible(scene).ok) return 0;
    const span = Math.max(Number(scene["热源温度_degC"]) - orcEvapTemp(scene) -
      Number(scene["换热端差_degC"]), 5.0);
    return m * CP[scene["载体"]] * span;
  }
  /* ORC 可行性前置（2026-10-09，DSH 复核 P5）
     判据：蒸发温度必须低于「热源温度 − 换热端差 − 最小传热温差」。
     我们 ORC 效率表的最低蒸发温度是 60℃，所以要求 tS − dT − 60 ≥ 3 K。
     不满足 → 该路径不参与推荐（返回 null / 0），而不是靠 clamp 硬算一个正值。
     ⚠ 边界：3 K 是**工程最小传热温差**（板式/翅片换热器常见 1~5 K 的下沿），
       属工程取值，不是某个项目的实测；它只决定"能不能算"，不参与效率数值。 */
  const ORC_PINCH_MIN_K = 3.0;
  function orcFeasible(scene) {
    const tS = Number(scene["热源温度_degC"]);
    const dT = Number(scene["换热端差_degC"]);
    if (!(tS > 0)) return { ok: false, headroomK: null, reason: "缺少热源温度" };
    const headroom = tS - (isNaN(dT) ? 0 : dT) - 60.0;
    if (headroom < ORC_PINCH_MIN_K) {
      return { ok: false, headroomK: headroom,
        reason: "热源 " + tS + "℃ 减换热端差后只剩 " + headroom.toFixed(1) +
                " K 高于 ORC 表最低蒸发温度 60℃（需 ≥" + ORC_PINCH_MIN_K + " K）" };
    }
    return { ok: true, headroomK: headroom };
  }
  /* ---------- 载体/下限类守卫与参数（2026-10-09，DSH 复核 ④①C1）----------

     ④ 载体守卫：以前 `CP[scene["载体"]]` 在载体名不在表里时是 undefined，
        乘积静默变成 **NaN** —— 探针会拿到"看起来正常但是空"的数
        （DSH 与我各踩过一次：我用 `热水/冷凝水` 而引擎要 `热水·冷凝水`，
         于是 q=NaN、ORC 仍报 2.3756%，差点误报）。现在未知载体**直接抛错**，
         让问题在调用点就暴露，而不是变成 NaN 往下游流。

     ①(b) 排烟下限参数化：`STEAM_EXHAUST_FLOOR_C`（150℃）原先硬编码，
        证书扰动不到它。C1 之后它会成为**决策驱动项**（TEG 可用热直接砍掉一半），
        所以必须做成 PRICES 参数并进证书扰动（120 / 180 两档）。
        ⚠ 语义：150℃ 是**偏保守的工程取值**（注释原文写"取 150℃ 作偏保守的典型值"，
        同条引的宁国水泥 AQC 实测是 360→91℃），**不是物理硬下限**；
        酸露点还取决于燃料含硫量（天然气约 50~60℃、高硫煤 120~150℃）→ 故参数化。
  */
  function cpOf(medium) {
    const cp = CP[medium];
    if (!(cp > 0)) {
      throw new Error("未知的载体名：" + String(medium) +
        "（必须在 IO.MEDIUM_MAP 的取值域内；可用值：" + Object.keys(CP).join(" / ") + "）");
    }
    return cp;
  }
  function isGasCarrier(medium) { return /烟气|排烟|废气/.test(String(medium)); }
  function steamExhaustFloorC() {
    return PRICES.steamExhaustFloorC === undefined
      ? STEAM_EXHAUST_FLOOR_C : Number(PRICES.steamExhaustFloorC);
  }

  function steamRecoveredKw(scene) {
    const m = Number(scene["流量_kg_s"]);
    if (!m) { const q = Number(scene["规模_kW"]); return q || 0; }
    const span = Math.max(Number(scene["热源温度_degC"]) - steamExhaustFloorC() -
      Number(scene["换热端差_degC"]), 5.0);
    return m * cpOf(scene["载体"]) * span;
  }

  /* ---- C1（2026-10-09，DSH 复核）：TEG 在**气体载体**上不能再用"降到 40℃"的液体口径 ----

     为什么：`heatFloor()` 的发电分支返回 40℃，那是**液体载体**（热水/冲渣水）的余热口径。
     套到烟气上等于忽略排烟酸露点 —— 任何人都不该越过这条**载体侧**约束
     （它和发电技术无关：蒸汽侧早就用了 150℃ 的排烟下限）。
     所以：气体载体 → 下限取 max(heatFloor, 排烟下限)[=150℃]；液体载体 → 保持 heatFloor(40℃)。
     这个不对称**是可以解释的**（气体有酸露点、液体没有），已写进口径字典。

     ⚠ DSH 的实现要求：**只改 TEG 的可用热，不要全局动 heatFloor** ——
       heatFloor 还被其它路径当 qDefault 用，全局改会波及一片。
     ⚠ 影响预判（DSH 实测给出）：275℃/10 kg/s 烟气/端差 10 → TEG 可用热 2475 → ≈1265 kW，
       净功率 123.8 → ≈63 kW（与 ORC 42.3 kW 同量级）。

     ⚠ **2026-10-11 更正（本条原先写错，并且已经误导过我一次）**：
     原写「TEG 的获胜温区收窄到约 215~280℃」**不成立**。独立实测扫描：
       · **烟气 150~400℃ × 流量 1~200 kg/s：TEG 一次未胜**；
       · 热水：仅在「ORC 不可行」的 100℃（各流量）与三个零散点（260℃/1、275℃/1、275℃/50 kg/s）胜出。
     ⇒ 正确表述：**TEG 只在 ORC 不可行或极弱的温区胜出**，不是某个温度带。
     上面那两个数（2475→1265 kW、123.8→63 kW）只是**该项可用热/净功率的修正**，
     **不能**当作"TEG 会赢"的证据。
     纪律（守则 §13 第 14 条）：**注释里的行为性断言必须附可复跑探针或数字**。 */
  function tegRecoveredKw(scene) {
    const m = Number(scene["流量_kg_s"]);
    if (!m) { const q = Number(scene["规模_kW"]); return q || 0; }
    const tSrc = Number(scene["热源温度_degC"]);
    const dT = Number(scene["换热端差_degC"]);
    const base = heatFloor(scene);
    const floor = isGasCarrier(scene["载体"]) ? Math.max(base, steamExhaustFloorC()) : base;
    return m * cpOf(scene["载体"]) * Math.max(tSrc - floor - dT, 0);
  }
  /* 按路径取回收热：发电类各用自己的设计降温程，其余沿用场景的 q */
  function qForPath(path, scene, qDefault) {
    if (path === "orc") return orcRecoveredKw(scene);
    if (path === "steam_pp") return steamRecoveredKw(scene);
    /* C1（2026-10-09）：TEG 用**自己**的可用热（气体载体套排烟下限），不再吃默认 q */
    if (path === "teg") return tegRecoveredKw(scene);
    return qDefault;
  }
  function heatFloor(scene) {
    const tSrc = Number(scene["热源温度_degC"]);
    const dT = Number(scene["换热端差_degC"]);
    /* 2026-10-10（B1）：发电类的源侧下限**从硬编码 40℃ 改成可调参数**。
       为什么：40℃ 是**工程默认值、不是物理下限**——TEG/ORC 的冷端必须低于载体出口温度，
       把水冷到 40℃ 隐含了"有 ≤30℃ 的低温冷源"这个假设（DSH 复核指出：不参数化就等于
       把不可审计的假设从气体侧挪到了液体侧）。默认仍 40℃ 以保持与已交付材料一致。 */
    if (scene["需求"] === "发电") return liquidFloorC();
    return Math.min(compSupplyTemp(scene) + dT, tSrc - HEAT_MIN_COOLDOWN_K);
  }
  function liquidFloorC() {
    return PRICES.liquidFloorC === undefined ? 40.0 : Number(PRICES.liquidFloorC);
  }

  function scaleBand(qKw) { return qKw < 1000 ? "小" : (qKw <= 5000 ? "中" : "大"); }

  function scaleMultiplier(path, band) {
    const rep = SCALE_REP_KW[band];
    const n = SCALE_EXP[path] !== undefined ? SCALE_EXP[path] : SCALE_EXP_DEFAULT;
    return Math.pow(rep / 3000.0, n - 1.0);
  }

  /* 该路径的"装机产出容量"kW —— 投资列的单位是「每 MW 装机产出」，
     所以规模分档必须用这个量，不能一律用可回收热量。
     发电类：热效率 × 回收热 = 电装机；直换/锅炉/储热/吸收式：能效列就是产出比；
     压缩式热泵与电压缩制冷另按 COP 折（它们的能效列是一次能源效率，不是 COP）。 */
  function capacityKw(path, q, effPct, compCop) {
    if (path === "comp") return q * (compCop || HP_COP);
    if (path === "comp_cool") return q * chillerCop();
    return q * effPct / 100.0;
  }

  /* ---------------- 压缩式热泵 COP：由常数改为随温度计算（2026-09-27） ----------------

     物理关系：COP = η × T_cond / (T_cond − T_evap)，温度用开尔文。
     η 取 0.5，由两个真实案例反算（不是拍的）：
       · 丹麦能源署工艺加热分册算例：热源 60℃ → 供汽 140℃（温升 80 K）、COP≈2.4
         → 卡诺 5.16 → η = 0.465
       · 珠海某产品样本：热源 65℃ → 出水 125℃、COP = 3.92
         → 卡诺 6.64 → η = 0.59
     端差各取 5 K：T_evap = 热源 − 5，T_cond = 需求温度 + 5。

     若 T_cond ≤ T_evap + 2（即不需要提温），返回 null —— 此时应当用直接换热，
     comp 不作为候选。否则会出现"不需要提温的热泵"这种无意义路径，
     也会让 COP 趋于无穷。 */
  const HP_ETA_CARNOT = 0.5;
  const HP_APPROACH_K = 5.0;
  /* ---- 上限保护：由"拍的常数"改成**实测包络**（2026-09-28，P1-2）----

     为什么必须封顶：常系数 η=0.5 的卡诺外推在小温升处会发散——
     热源 65℃→冷凝 90℃（模型口径温升 25 K）算得 COP 7.26，而实测机组在这个
     温升下是 4~5。以前用一条"工程判断"的常数 5.5 封顶；现在改成实测包络。

     实测点（温升按本模型口径换算：冷凝温度 − 蒸发温度 = 需求−热源+2×端差）：
       · 西安交通大学 7 MW 级燃气锅炉烟气热泵**现场实测 COP 6.75**（同项目仿真 6.65，
         偏差 −1.5%）——公开资料只给 COP，热源/供水温度未给，按"烟气 55℃ → 供水 60℃"
         估算对应模型口径温升约 15 K。这一条把包络的低温升端从 5.3 抬到 **6.75**：
         小温升 + 大机组确实能做到 6~7，而原来的 5.3 会把它误封顶。
       · KOBELCO HEMⅢ-HR95WZ **大型机组**：热水温升 30~35 K 处 COP **5.3**
         → 模型口径温升 40~45 K
       · R515B 变频涡旋**实验样机**：热源 50℃、出水 70→85℃，COP 4.48→3.25
         （热水温升 20→35 K → 模型口径 30~45 K）
       · 珠海某产品样本：热源 65℃ → 出水 125℃、COP **3.92**（模型口径 70 K）
       · 丹麦能源署工艺加热算例：热源 60℃ → 供汽 140℃、COP≈**2.4**（模型口径 90 K）

     包络取"同一温升区段里不同机型的**上界**"，且必须随温升单调不增
     （COP 不可能在温升变大时反而变高）：
       15 K → 6.75（西交大 7 MW 实测）→ 5.3（45 K，KOBELCO）→ 3.92（70 K）→ 2.4（≥90 K）
     R515B 样机在 45 K 处只有 3.25，而大型机组同区段有 5.3 —— 取 5.3 意味着
     本包络**不保证小机组能达到**。小机组的 COP 折减还没有数据，
     已登记为待标定项（拿到小机组实测即补）。

     ⚠ 诚实性：η=0.5 本身在实测区间内（按 5 K 端差统一反算，四个实测点的
     η = 0.39（R515B 小温升）/ 0.40（R515B 大温升）/ 0.68（珠海样本）/ 0.52（DEA 算例），
     中位约 0.5）——所以 η 不再改，改的是小温升处的**上限**。 */
  const HP_COP_ENVELOPE = [
    [15.0, 6.75],   // 西安交大 7 MW 燃气锅炉烟气热泵现场实测（温升按假设条件估算）
    [45.0, 5.30],   // KOBELCO 大型机组（该区段上界；R515B 样机同点只有 3.25）
    [70.0, 3.92],   // 珠海产品样本
    [90.0, 2.40]    // 丹麦能源署工艺加热算例
  ];
  function hpCopEnvelope(liftK) {
    const p = HP_COP_ENVELOPE;
    const l = Number(liftK);
    if (!(l > 0)) return p[0][1];
    if (l <= p[0][0]) return p[0][1];
    if (l >= p[p.length - 1][0]) return p[p.length - 1][1];
    for (let i = 0; i < p.length - 1; i++) {
      if (l >= p[i][0] && l <= p[i + 1][0]) {
        const f = (l - p[i][0]) / (p[i + 1][0] - p[i][0]);
        return p[i][1] + (p[i + 1][1] - p[i][1]) * f;
      }
    }
    return p[p.length - 1][1];
  }

  /* 热泵要送到的温度：按需求类型给默认值（与 stage1 里各需求的默认温度一致） */
  function compSupplyTemp(scene) {
    const demand = scene["需求"];
    const tDem = scene["需求温度_degC"];
    if (demand === "供暖·热水") return (tDem || 60.0);
    if (demand === "干燥") return (tDem || 100.0);
    if (demand === "工艺蒸汽") return (tDem || 152.0);
    if (demand === "储热调峰") return (tDem || 90.0);
    return (tDem || 60.0);
  }

  /* 返回 { cop, tEvapC, tCondC }；无法提温或 COP≤1 时返回 null */
  /* 热泵"小机组折减"（2026-09-28，第六轮 N6）：
     实测包络是按大型机组（KOBELCO 5.3、西交大 6.75）定的上界，而 10~100 kW 小机组的
     实测 COP 只到包络的 0.73~0.94（R515B 25 kW 4.48 vs 5.3＝0.85；R134a 36 kW
     3.85~5.0 vs 5.3＝0.73~0.94）→ 中位取 0.8，规模代理用热源侧可回收热。 */
  function hpSizeFactor(qKw) {
    const p = Math.max(Number(qKw) || 0, 1.0);
    if (p <= 30.0) return 0.80;
    if (p >= 500.0) return 1.00;
    const f = (Math.log10(p) - Math.log10(30)) / (Math.log10(500) - Math.log10(30));
    return 0.80 + 0.20 * f;
  }

  function compCopFor(scene) {
    const tSrc = Number(scene["热源温度_degC"]);
    if (!(tSrc > 0)) return null;
    const tEvapC = tSrc - HP_APPROACH_K;
    const tCondC = compSupplyTemp(scene) + HP_APPROACH_K;
    if (!(tCondC > tEvapC + 2.0)) return null;
    const th = tCondC + 273.15;
    const tc = tEvapC + 273.15;
    const copRaw = HP_ETA_CARNOT * th / (th - tc);
    if (!(copRaw > 1.0)) return null;
    const liftK = tCondC - tEvapC;
    const cap = hpCopEnvelope(liftK);
    let sizeF = 1.0;
    try { sizeF = hpSizeFactor(recoveredHeatKw(scene)); } catch (e) { sizeF = 1.0; }
    const cop = Math.min(copRaw, cap) * sizeF *
      (PRICES.effScale === undefined ? 1.0 : PRICES.effScale);
    return { cop: cop, copRaw: copRaw, capped: cop < copRaw - 1e-9,
             cap: cap, liftK: liftK, sizeFactor: sizeF,
             tEvapC: tEvapC, tCondC: tCondC };
  }

  /* 年产出价值（万元 / MW装机·年）。口径见 ECON_GRADE 上方说明。 */
  function annualValueWanMw(path, hours) {
    if (path === "orc" || path === "steam_pp" || path === "teg") {
      return hours * elecPrice() * 1000.0 / 10000.0;                 // 每 MW 电装机
    }
    /* ---- 储热类：收益口径由"替代天然气"单一算法改为可选两套算法（2026-09-28 P1-4）----
       背景：储热只做时间搬移、不产出热量，它的收益取决于**替代什么基准**：
         口径 A「售热/替代燃料」：放出的热按热价卖（或替代燃气锅炉）→ 与直接换热同口径；
         口径 B「峰谷套利」：谷段充电、峰段放热，替代的是**峰段电加热**
                （电加热效率按 0.95），价值 = 放热量 × 峰段电价 ÷ 0.95；
               峰段电价 = 谷电价 + 峰谷价差（11 省分时电价数据）。
       两套算法算的是**不同基准下的价值**，不是可以无条件相加的两笔收益：
         · 叠加口径（stack）只在"卖热给用户"与"该用户原本用峰段电加热"同时成立时有效，
           否则等于把同一份热按两个基准各卖一次 —— 界面与边界页都写明这一点。
       年吞吐量按「峰段等效满功率放电小时」计（默认 1,500 h ≈ 每天 4~5 h 峰段），
       不沿用工况库的 6,000 h（那是余热可用小时，不是储热的年循环小时）。 */
    if (path === "tc_storage" || path === "pcm_storage") {
      const sh = storageHoursOf(hours);
      const heatVal = sh * 3.6 * heatPrice() / 10000.0;
      const arbVal = sh * 1000.0 * (valleyElec() + peakValley()) / ELEC_HEAT_ETA / 10000.0;
      const mode = storageRevenueMode();
      if (mode === "off") return 0.0;
      if (mode === "arbitrage") return arbVal;
      if (mode === "stack") return heatVal + arbVal;
      return heatVal;
    }
    // 制冷类（吸收式与电压缩）：产出是冷量，价值按"替代电制冷的电耗"算，
    // 与减排列 coolingAbsReduction 的口径一致（Q_cold ÷ COP_E × 电价）。
    if (path === "comp_cool" || path === "abs_cool") {
      return (1.0 / chillerCop()) * hours * elecPrice() * 1000.0 / 10000.0;   // 替代电制冷耗电
    }
    // 其余为产热路径：每 MW 热装机 × 小时 = MWh → GJ → 替代天然气
    return hours * 3.6 * heatPrice() / 10000.0;
  }

  /* 年能耗成本（万元 / MW装机·年）：只对"自己要耗电/耗汽"的路径非零 */
  function energyCostWanMw(path, hours, compCop, demand) {
    if (path === "comp") {
      return (1.0 / (compCop || HP_COP)) * hours * elecPrice() * 1000.0 / 10000.0;
    }
    if (path === "comp_cool") {
      return (1.0 / chillerCop()) * hours * elecPrice() * 1000.0 / 10000.0;
    }
    if (path === "abs_ext") {
      return (1.0 / COP_H_ABS_EXT) * hours * 3.6 * STEAM_PRICE / 10000.0 * STEAM_OPS_FACTOR;
    }
    /* 储热类：按"谷电充电"算充电成本（2026-09-27）。
       口径：每 MW 装机的年放电热量 ÷ 储放热效率 = 年充电量；× 谷段电价 0.35 元/kWh。
       依据：工况库"储热调峰-高温熔盐"一行标注为「谷电充热」，故成本侧应计电费；
       谷电价取山东 2025-04 一般工商业 35 kV 低谷 0.35 元/kWh（第三轮检索）。
       注：若某项目是"余热直接充热"（不耗电），应把谷电价调到接近 0 再评估。 */
    if (path === "tc_storage" || path === "pcm_storage") {
      const eff = path === "tc_storage" ? 0.70 : 0.75;   // 与能效列的储放热效率一致
      /* 充电量按"峰段等效放电小时"计（2026-09-28 P1-4）：储热的年循环量由峰段
         时长决定，不是余热可用小时。口径 B（套利）下充电成本同样按谷电算。 */
      const sh = storageHoursOf(hours);
      /* 输配电耗（第六轮 N4）：放热侧也要把热送到用户，这份电耗与充热方式无关 */
      const transport = sh * 3.6 * transportKwhGjFor(demand) * elecPrice() / 10000.0;
      if (storageChargeMode() === "waste") return transport;   // 余热直接充热：不计充电电费
      return (1.0 / eff) * sh * valleyElec() * 1000.0 / 10000.0 + transport;
    }
    /* 产热类路径的输配电耗（第六轮 N4）：原来这几条路径的运行成本是 0，
       等于假设"热会自己走到用户那里"。按 3.43 kWh/GJ（国内热力站实测均值）计。 */
    if (path === "direct" || path === "whb_steam") {
      return hours * 3.6 * transportKwhGjFor(demand) * elecPrice() / 10000.0;
    }
    return 0.0;
  }

  /* 回收期（年）= 投资 ÷ (年产出价值 − 年能耗 − 年运维)
     运维 = 投资 × 费率。这个式子和 ORC 那一行是同一套：2380 ÷ (520 − 0 − 95.2) = 5.60 年，
     与台账引文的 5.58 年吻合 —— 说明表里原本的 5.6 年就是这么算的，
     所以我们只是把它显式化并对其它有出处的路径统一应用。 */
  function paybackYears(path, investWanMw, hours, compCop, demand) {
    const rate = OPEX_RATE[path] !== undefined ? OPEX_RATE[path] : OPEX_RATE_DEFAULT;
    const net = annualValueWanMw(path, hours)
      - energyCostWanMw(path, hours, compCop, demand)
      - investWanMw * rate;
    if (!(net > 0)) return null;
    return investWanMw / net;
  }

  /* 收益覆盖不了运行成本时的"回收期占位值"。
     为什么需要：有出处的路径回收期改成公式现算后，可能出现 net ≤ 0
     （最典型：谷电充热的储热按"售热"口径算 —— 充电 0.47 元/kWh热、卖热 0.35 元/kWh热，
     必然亏）。这时不能退回那个没有出处的常数，也不能留空（TOPSIS 会算成 NaN），
     统一记 99 年，界面显示为"—（收益不足以覆盖运行成本）"。 */
  const NO_PAYBACK_YEARS = 99.0;

  function absCoolCop(t) {
    if (t >= 85.0) return 0.7;
    if (t >= ABS_COOL_T_MIN) return 0.6;
    return null;
  }
  /* ---------- TEG 转换效率随温差（2026-09-29，第七轮 R5-3）----------
     原来用常数 5%，但实测显示 TEG 效率强烈依赖温差：
       · 商用 Bi₂Te₃ 系统：ΔT=50 K→1.5%、100 K→2.5%、200 K→4.5%、350 K→6.0%
         （350℃ 点为实验峰值 3.0 W / 6.0%；50~300℃ 为实验+建模混合点）
       · 纳米结构 Bi₂Te₃ 模块：ΔT=100 K→8.2%（实验室高性能材料上限）
       · 块体材料文献：7%@ΔT≈275 K
     取商用曲线作主口径（最保守也最可复现），即 ΔT=100 K 时 2.5% —— 原常数 5% 偏乐观约 2 倍。
     ΔT 用"热源温度 − 环境温度"近似（TEG 热端=热源、冷端=环境）。 */
  const TEG_CURVE = [[50.0, 1.5], [100.0, 2.5], [200.0, 4.5], [350.0, 6.0]];
  function tegEffPct(scene) {
    const t = Number(scene["热源温度_degC"]);
    if (!(t > 0)) return BASE_INDICATORS.teg[0];
    const dt = Math.max(t - ambientC(), 10.0);
    const c = TEG_CURVE;
    if (dt <= c[0][0]) return c[0][1];
    if (dt >= c[c.length - 1][0]) return c[c.length - 1][1];
    for (let i = 0; i < c.length - 1; i++) {
      if (dt >= c[i][0] && dt <= c[i + 1][0]) {
        const f = (dt - c[i][0]) / (c[i + 1][0] - c[i][0]);
        return c[i][1] + (c[i + 1][1] - c[i][1]) * f;
      }
    }
    return c[c.length - 1][1];
  }

  /* ---- 二类吸收式（升温型热泵）COP：由常数改成连续曲线（2026-09-28，P1-3）----

     原来只有一个常数 0.45（工艺蒸汽用）＋ 一句"单级 0.45 / 两级 0.30"的提示文字，
     模型本身不区分温升与驱动温度。实测与标准数据是够画一条曲线的：

       · 23 K 温升下，驱动温度 65 / 70 / 75℃ → COP 0.425 / 0.44 / 0.45
         （温升一样、驱动温度越高 COP 越高）
       · 三洋行业样本：85℃ 驱动、35~40 K 温升 → COP 0.47~0.48
       · 工信部 2021 指南：单级 +30~40 K → 0.45~0.48；两级 +40~60 K → 0.30
       · GB/T 报批稿限定值：单级 ≥0.44、两级 ≥0.28

     拟合分两段（不引入新参数，全部由上面四个数据点定）：
       ① 基准值随驱动温度插值：60→0.408、65→0.425、70→0.4375、75→0.45、85→0.475、95→0.48
       ② 温升折减：温升 ≤40 K 不折减；40→60 K 线性降到 0.30（两级段）
     适用区间：驱动 60~95℃、温升 10~60 K（超出取端点值，并夹在 0.28~0.50）。 */
  const ABS_II_DRIVE = [[60, 0.408], [65, 0.425], [70, 0.4375],
                        [75, 0.45], [85, 0.475], [95, 0.48]];
  const ABS_II_LIFT_KNEE = 40.0;
  const ABS_II_LIFT_MAX = 60.0;
  const ABS_II_COP_AT_MAX_LIFT = 0.30;

  function lerpPairs(pairs, x) {
    if (!pairs || !pairs.length) return null;
    if (x <= pairs[0][0]) return pairs[0][1];
    if (x >= pairs[pairs.length - 1][0]) return pairs[pairs.length - 1][1];
    for (let i = 0; i < pairs.length - 1; i++) {
      if (x >= pairs[i][0] && x <= pairs[i + 1][0]) {
        const f = (x - pairs[i][0]) / ((pairs[i + 1][0] - pairs[i][0]) || 1);
        return pairs[i][1] + (pairs[i + 1][1] - pairs[i][1]) * f;
      }
    }
    return pairs[pairs.length - 1][1];
  }

  /* tDriveC：驱动热源温度℃；tDemandC：要送到的温度（蒸汽/热水）℃ */
  function absIICop(tDriveC, tDemandC) {
    const td = Number(tDriveC), tD = Number(tDemandC);
    if (!(td > 0) || !(tD > 0)) return COP_II_ABS_SELF;
    const drive = lerpPairs(ABS_II_DRIVE, td);
    const lift = tD - td;
    let cop = drive;
    if (lift > ABS_II_LIFT_KNEE) {
      const f = Math.min((lift - ABS_II_LIFT_KNEE) /
                         (ABS_II_LIFT_MAX - ABS_II_LIFT_KNEE), 1.0);
      cop = drive - (drive - ABS_II_COP_AT_MAX_LIFT) * f;
    }
    return clamp(cop, 0.28, 0.50);
  }

  function stage1(scene) {
    const t = Number(scene["热源温度_degC"]);
    const demand = scene["需求"];
    const tDem = scene["需求温度_degC"];
    const driver = scene["驱动来源"] || "余热自驱动";
    const cont = scene["连续性"] || "连续";
    const keep = {}, why = {};
    const setk = (p, ok, reason) => { keep[p] = ok; why[p] = reason; };

    if (demand === "发电") {
      setk("orc", 110 <= t && t <= 350,
        (110 <= t && t <= 350) ? ("热源 " + t + "℃ 在 ORC 适用区间 110~350℃")
          : (t < 110 ? ("热源 " + t + "℃ <110℃，ORC 温差不足") : ("热源 " + t + "℃ >350℃，超出 ORC 标定上限，应走蒸汽朗肯")));
      setk("steam_pp", steamBoundC() <= t && t <= 650,
        (steamBoundC() <= t && t <= 650)
          ? ("热源 " + t + "℃ 满足蒸汽朗肯候选区间 " + steamBoundC() + "~650℃（锅炉出口按 min(max(t-100,180),540) 映射；边界可调，280℃ 是数据覆盖边界）")
          : (t < steamBoundC() ? ("热源 " + t + "℃ <" + steamBoundC() + "℃，蒸汽朗肯经济性不足") : ("热源 " + t + "℃ >650℃，超出 v2 标定上限")));
      /* C1 配套（2026-10-09）：可用热为 0 就不能进候选 —— 否则会出现
         "没热量却照样算投资/回收期"的混搭（DSH 提醒、我加的守卫实测抓到过）。 */
      setk("teg", t >= 40 && tegRecoveredKw(scene) > 0,
        t < 40 ? "温差不足"
          : (tegRecoveredKw(scene) <= 0
            ? ("气体载体可用热为 0（排烟下限 " + steamExhaustFloorC() + "℃ 已高于可降温）→ 不进候选")
            : "TEG 适合 ≥40℃ 温差发电（兜底候选）"));
      ["direct", "whb_steam", "abs_self", "abs_ext", "comp", "tc_storage", "pcm_storage", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为发电：该路径不产出电力"));
    } else if (demand === "工艺蒸汽") {
      const tSteam = tDem || 152.0;
      setk("whb_steam", t >= tSteam + 20,
        t >= tSteam + 20 ? ("热源 " + t + "℃ ≥ 蒸汽 " + tSteam + "℃ + 端差 20℃，可直接产汽")
          : ("热源 " + t + "℃ 不足以直接产生 " + tSteam + "℃ 蒸汽（需 ≥" + (tSteam + 20) + "℃）"));
      /* 二类（升温型 AHT）用于制蒸汽时的可行性（2026-09-27 按第四轮实测数据加门槛）：
         二类需要"驱动温度 < 输出温度"，即热源必须**低于**蒸汽温度；且温升有上限——
         工信部 2021 指南：单级 +30~40 K → COP 0.45~0.48、两级 +40~60 K → 0.3；
         GB/T 报批稿限定值 单级 ≥0.44、两级 ≥0.28。故要求 90 ≤ 热源 < 蒸汽温度−5 且温升 ≤60 K。
         若热源本身已高于蒸汽温度，应直接产汽（whb_steam），而不是用升温型热泵。 */
      const tSteamNeed = tDem || 152.0;
      const absLift = tSteamNeed - t;
      setk("abs_self", t >= 90 && absLift > 5 && absLift <= 60,
        (t >= 90 && absLift > 5 && absLift <= 60)
          ? ("二类升温型：热源 " + t + "℃ → 蒸汽 " + tSteamNeed +
             "℃，温升 " + absLift.toFixed(0) + " K、COP≈" +
             absIICop(t, tSteamNeed).toFixed(3) +
             "（连续曲线：驱动温度与温升都进入计算，见边界页）")
          : (t < 90 ? ("吸收式自驱动需 ≥90℃ 驱动热源（当前 " + t + "℃）")
             : (absLift <= 5 ? ("热源已高于蒸汽需求温度，应直接产汽（whb_steam），无需升温型热泵")
                : ("温升 " + absLift.toFixed(0) + " K 超过 60 K，超出单/两级吸收式标定范围"))));
      const ciSteam = compCopFor(scene);
      setk("comp", !!ciSteam,
        ciSteam
          ? ("压缩式热泵以电驱动，温升 " +
             (ciSteam.tCondC - ciSteam.tEvapC).toFixed(0) +
             " K、COP≈" + ciSteam.cop.toFixed(2) + "（随温度计算）")
          : "热源已高于需求温度，无需提温 —— 请用直接换热（热泵在无温升时无意义）");
      setk("abs_ext", false, "v2 中外购蒸汽驱动吸收式仅用于供暖·热水需求（扩展点）");
      ["direct", "orc", "steam_pp", "teg", "tc_storage", "pcm_storage", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为工艺蒸汽：该路径不产出蒸汽"));
    } else if (demand === "供暖·热水") {
      const lo = Math.max(60.0, (tDem || 60.0) + Number(scene["换热端差_degC"]));
      setk("direct", t >= lo,
        t >= lo ? ("热源 " + t + "℃ ≥ 直接换热下限 " + lo.toFixed(0) + "℃（max(60, 需求温度+端差)）")
          : ("热源 " + t + "℃ < " + lo.toFixed(0) + "℃，直接换热不可行"));
      setk("abs_self", t >= 90, t >= 90 ? "热源 ≥90℃ 可自驱动吸收式" : "吸收式自驱动需 ≥90℃ 驱动热源");
      setk("abs_ext", driver === "外购蒸汽" && t >= 25,
        (driver === "外购蒸汽" && t >= 25) ? "外购蒸汽驱动吸收式：低温余热 + 蒸汽驱动（≥25℃ 可用）"
          : (driver !== "外购蒸汽" ? "未提供外购蒸汽，外购蒸汽驱动吸收式不可用" : "热源温度过低"));
      setk("comp", !!compCopFor(scene),
        compCopFor(scene)
          ? ("压缩式热泵提温：温升 " +
             (compCopFor(scene).tCondC - compCopFor(scene).tEvapC).toFixed(0) +
             " K、COP≈" + compCopFor(scene).cop.toFixed(2) + "（随温度计算）")
          : "热源已满足需求温度，无需提温 —— 请用直接换热");
      ["whb_steam", "orc", "steam_pp", "teg", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为供暖·热水：该路径不直接产热"));
      /* 储热不参与"用热"需求的排序（2026-09-27 修正）。
         原因：储热提供的是**时间搬移**服务，不能自己产出热量。把它和直接换热/热泵
         放在同一张表里比"能效/减碳"，它的减碳会被算成与直接换热相同的
         "全部回收热替代天然气"，等于让储热凭空领一份燃料替代收益 ——
         实测后果：数据中心案例（真实工程用热泵）会被它顶成第一。
         要做"削峰填谷/时空解耦"请用"储热调峰"需求类型评价，那里它才是正解。 */
      ["tc_storage", "pcm_storage"].forEach((p) => {
        setk(p, false, "储热只做时间搬移、不能单独满足连续用热需求；请改用" +
          "「储热调峰」需求评价储热方案");
      });
    } else if (demand === "供冷") {
      if (driver === "外购蒸汽") {
        PATH_KEYS.forEach((p) => setk(p, false,
          "外购蒸汽驱动吸收式制冷是用能设备（非余热回收）；请将驱动来源改为余热自驱动（利用废热）或外购电力（电制冷）"));
      } else {
        setk("abs_cool", driver === "余热自驱动" && ABS_COOL_T_MIN <= t && t <= 650,
          (driver === "余热自驱动" && ABS_COOL_T_MIN <= t && t <= 650)
            ? ("热源 " + t + "℃ ≥" + ABS_COOL_T_MIN.toFixed(0) + "℃ 且驱动来源为余热自驱动：可驱动吸收式制冷（≥85℃ COP≈0.7；80~84℃ COP≈0.6）")
            : (driver === "余热自驱动" ? ("吸收式制冷需 ≥" + ABS_COOL_T_MIN.toFixed(0) + "℃ 驱动热源（当前 " + t + "℃）")
              : "吸收式制冷需“余热自驱动”口径（当前驱动来源=" + driver + "）"));
        setk("comp_cool", driver === "外购电力",
          driver === "外购电力" ? "电压缩制冷以电驱动（外购电力口径），无废热时作为基准方案"
            : "电压缩制冷需“外购电力”口径（当前驱动来源=" + driver + "）");
        PATH_KEYS.forEach((p) => { if (p !== "abs_cool" && p !== "comp_cool") setk(p, false, "需求为供冷：该路径不产出冷量"); });
      }
    } else if (demand === "干燥") {
      const tDry = tDem || 100.0;
      const lo = Math.max(60.0, tDry + Number(scene["换热端差_degC"]));
      setk("direct", t >= lo,
        t >= lo ? ("热源 " + t + "℃ ≥ 干燥热风下限 " + lo.toFixed(0) + "℃（默认需求温度 100℃+端差）")
          : ("热源 " + t + "℃ < " + lo.toFixed(0) + "℃，直接换热干燥不可行"));
      setk("whb_steam", t >= tDry + 20,
        t >= tDry + 20 ? ("热源 " + t + "℃ ≥ 干燥用蒸汽下限 " + (tDry + 20).toFixed(0) + "℃（默认 100℃+20℃）")
          : ("热源 " + t + "℃ 不足以直接产干燥用蒸汽（需 ≥" + (tDry + 20).toFixed(0) + "℃）"));
      setk("abs_self", t >= 90, t >= 90 ? "热源 ≥90℃ 可驱动吸收式热泵供热风（一类 COP1.7）" : "吸收式热泵需 ≥90℃ 驱动热源");
      setk("comp", !!compCopFor(scene),
        compCopFor(scene)
          ? ("热泵烘干提温：温升 " +
             (compCopFor(scene).tCondC - compCopFor(scene).tEvapC).toFixed(0) +
             " K、COP≈" + compCopFor(scene).cop.toFixed(2) + "（随温度计算）")
          : "热源已满足干燥温度，无需提温 —— 请用直接换热");
      setk("abs_ext", false, "外购蒸汽驱动仅用于供暖·热水需求（干燥请用余热自驱动/热泵）");
      ["orc", "steam_pp", "teg", "tc_storage", "pcm_storage", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为干燥：该路径不直接烘干"));
    } else if (demand === "储热调峰") {
      setk("tc_storage", true, "储热路径可跨时段调峰");
      setk("pcm_storage", true, "储热路径可跨时段调峰");
      setk("direct", t >= Math.max(60.0, (tDem || 60.0) + Number(scene["换热端差_degC"])), "供暖调峰候选");
      setk("abs_self", t >= 90, t >= 90 ? "提温调峰候选" : "驱动热源不足");
      setk("abs_ext", driver === "外购蒸汽" && t >= 25, "外购蒸汽驱动候选");
      setk("comp", !!compCopFor(scene),
        compCopFor(scene)
          ? ("提温调峰候选：COP≈" + compCopFor(scene).cop.toFixed(2) + "（随温度计算）")
          : "无需提温");
      setk("orc", 110 <= t && t <= 350, (110 <= t && t <= 350) ? "发电调峰候选" : "超出 ORC 区间（110~350℃）");
      setk("steam_pp", steamBoundC() <= t && t <= 650,
        (steamBoundC() <= t && t <= 650) ? "发电调峰候选" : ("超出朗肯候选区间（" + steamBoundC() + "~650℃）"));
      setk("teg", t >= 40 && tegRecoveredKw(scene) > 0,
        t < 40 ? "温差不足"
          : (tegRecoveredKw(scene) <= 0 ? "可用热为 0（受排烟下限 " + steamExhaustFloorC() + "℃ 限制）"
            : "发电兜底候选"));
      setk("whb_steam", t >= (tDem || 152.0) + 20, "产汽调峰候选");
      setk("abs_cool", false, "储热调峰需求不产冷");
      setk("comp_cool", false, "储热调峰需求不产冷");
    }
    PATH_KEYS.forEach((p) => {
      // 技术成熟度门槛优先于各需求的放行规则：TRL<6 一律不进推荐池
      if (!trlOk(p)) {
        setk(p, false, "技术成熟度 TRL " + TRL[p] + "，未达商业化门槛（<" + TRL_MIN +
          "）：仅作技术储备展示，不参与经济性排序");
        return;
      }
      if (why[p] === undefined) setk(p, keep[p] === true, "通过第一级筛选");
    });
    return { keep, reasons: why };
  }

  // ---------- 效率表查询 ----------
  function pctLookupRow(tbl, c) {
    if (!tbl || !tbl.length) return null;
    if (c <= tbl[0][0]) return tbl[0];
    if (c >= tbl[tbl.length - 1][0]) return tbl[tbl.length - 1];
    for (let i = 0; i < tbl.length - 1; i++) {
      if (c >= tbl[i][0] && c <= tbl[i + 1][0]) {
        const f = (c - tbl[i][0]) / ((tbl[i + 1][0] - tbl[i][0]) || 1);
        return tbl[i].map((v, j) => (j === 4 ? tbl[i + 1][j] : tbl[i][j] + (tbl[i + 1][j] - tbl[i][j]) * f));
      }
    }
    return tbl[tbl.length - 1];
  }

  // ORC 中位热效率（%）：heater 出口上限 = t - dT 的累计中位数
  function orcEffPct(tSrc, dT) {
    /* 查表温度 2026-09-27 改为**设计蒸发温度**（= 热源 − 设计降温程 50 K），
       而不是原来的 热源 − 端差 —— 后者会同时高估回收热与效率。
       这样查表温度与 qForPath 里的降温下限是同一套口径。 */
    /* 下限 2026-09-27 由 100℃ 下调到 60℃：效率表已扩到「异丁烷低压段 + R245fa」
       （tools/scan_orc_lowtemp.py，合并 7,550 点），可表示 60℃ 蒸发这种低温宽温差设计 */
    return orcEffByEvapTemp(orcDesignEvapTemp(tSrc, dT));
  }

  /* 按"设计蒸发温度"直接查效率表（%）。P2-9：设计点扫描与主流程共用这一个入口。 */
  function orcEffByEvapTemp(tEvapC) {
    if (!TABLES || !TABLES.orcPct) return null;
    const row = pctLookupRow(TABLES.orcPct, clamp(Number(tEvapC), 60, 360));
    if (!row) return null;
    return row[2] / 10.0; // p50 kW/MW ÷ 10 → %
  }

  // 蒸汽朗肯中位热效率（%）：锅炉出口 = clamp(t-100,180,540)，逐点中位数曲线插值
  function steamEffPct(tSrc) {
    if (!TABLES || !TABLES.stCurve || TABLES.stCurve.length < 2) return null;
    const tb = clamp(tSrc - 100.0, 180.0, 540.0);
    const curve = TABLES.stCurve;
    if (tb <= curve[0][0]) return curve[0][1];
    if (tb >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    for (let i = 0; i < curve.length - 1; i++) {
      if (tb >= curve[i][0] && tb <= curve[i + 1][0]) {
        const f = (tb - curve[i][0]) / ((curve[i + 1][0] - curve[i][0]) || 1);
        return curve[i][1] + (curve[i + 1][1] - curve[i][1]) * f;
      }
    }
    return curve[curve.length - 1][1];
  }
  /* ---- 蒸汽轮机效率—容量曲线（2026-10-09，第十五批；取代 A1 的"固定区间"）----

     为什么必须换掉固定值：我们那张蒸汽效率表**不是实测拟合**，而是**我们自己用 CoolProp
     跑的 1,600 个工况**（见知识手册"核心仿真数据"与 docs/2026-09-20-12条路径指标口径体检.md），
     里面**隐含**了一个固定假设：等效等熵效率 **0.7891**（二分反解出来的）。
     也就是说这个 0.7891 是**模型假设**，不是任何一台机器的实测值。

     实测锚点（第七轮 R3，全部落在「等熵/缸效率」口径）：
       · 30 MW 背压机 **61.70%**（DCS 高频实测）
       · 33 MW 凝汽机 **64.22%**（DCS 高频实测）
       · 330 MW 亚临界 现场试验 **缸效率 80.4%~88.5%**（缸效率≈相对内效率，与等熵可比）
     三个点做对数拟合 →  eta_t = 0.4385 × P_MW^0.1046（拟合值与三点偏差 ≤2%）。

     ⚠ 诚实性边界（**必须带着这句话引用**）：
       1) 我们所有蒸汽工况的装机都在 **30 MW 以下**，而实测锚点最低是 30 MW
          → **<30 MW 属于外推区，没有等熵实测**。所以那里**不外推**幂律（外推到 1 MW 会得 44%，
          明显过低），而是**取最小实测机 0.617 并保持**，区间给 0.55~0.80
          （下沿＝外推被截断前的保守下界，上沿＝水泥窑 MW 级余热汽轮机**设计绝对内效率** 80%）。
       2) 30~330 MW 段：主值取拟合，区间 ±(0.92~1.05) 覆盖 61.7 vs 64.2 的实测散布与缸效率上沿。
       3) 口径仍不完全统一（等熵 / 缸效率 / 绝对内）→ 只作**效率量级**修正，不作精度声明。

     净效果：对我们实际的 MW 级蒸汽工况，等效等熵效率由 0.7891 → **0.617**，
     即蒸汽热效率下调约 **21.8%**（这正是第七轮"对小机组偏乐观约 20%"的落地修正）。 */
  const STEAM_ETA_REF = 0.7891;                      // 我们仿真表隐含的固定假设（反解值）
  const STEAM_CAP_FIT = { a: 0.4385, b: 0.1046 };    // eta = a * P_MW^b（3 点对数拟合）
  const STEAM_ETA_SMALL = 0.617;                     // <30 MW：取最小实测机保持（不外推）
  const STEAM_ETA_SMALL_LO = 0.55;
  const STEAM_ETA_SMALL_HI = 0.80;
  function steamEtaTByCap(capKw) {
    const pMw = Math.max(Number(capKw) || 0, 0.001) / 1000.0;
    if (pMw >= 30.0) {
      const mid = Math.min(0.92, Math.max(0.60,
        STEAM_CAP_FIT.a * Math.pow(pMw, STEAM_CAP_FIT.b)));
      return { mid: mid, low: mid * 0.92, high: mid * 1.05, inData: true,
               note: "30~330 MW 实测锚点（等熵/缸效率口径）" };
    }
    return { mid: STEAM_ETA_SMALL, low: STEAM_ETA_SMALL_LO, high: STEAM_ETA_SMALL_HI,
             inData: false,
             note: "<30 MW 无等熵实测：取最小实测机 61.7% 保持，区间 55%~80%" };
  }
  function steamEtaFactor(capKw) {
    const s = PRICES.steamEtaCapScale === undefined ? 1.0 : Number(PRICES.steamEtaCapScale);
    return (steamEtaTByCap(capKw).mid * s) / STEAM_ETA_REF;
  }
  /* 蒸汽朗肯候选边界温度（℃，默认 280）。
     为什么变成参数：D1（2026-10-09）证明 280 是**数据覆盖下限**被写成规则，
     不是算出来的经济边界（造价惩罚全区间只有 5.2~6.7×、且几乎与温度无关；
     能效上蒸汽在 280℃ 以上全面优于 ORC）。所以边界应当可调，并进证书扰动。 */
  function steamBoundC() {
    return PRICES.steamBoundC === undefined ? 280.0 : Number(PRICES.steamBoundC);
  }
  /* 蒸汽侧效率区间（界面用）。capKw 省略时按 1 MW 算（我们蒸汽工况都在 <30 MW 段）。 */
  function steamEffRangePct(tSrc, capKw) {
    const e = steamEffPct(tSrc);
    if (e === null || e === undefined) return null;
    /* ⚠ 2026-10-13（P0-1 配套）：区间必须与主值**同口径** —— 主值（netEffPct）已补乘
       generatorEta，这里若不同步乘，就会出现"区间与点值不是一个东西"。 */
    const cap = (capKw === undefined || capKw === null) ? 1000.0 : capKw;
    const band = steamEtaTByCap(cap);
    const g = generatorEta(cap);
    return { mid: e * (band.mid / STEAM_ETA_REF) * g,
             low: e * (band.low / STEAM_ETA_REF) * g,
             high: e * (band.high / STEAM_ETA_REF) * g,
             refEtaT: STEAM_ETA_REF, etaT: band.mid, inData: band.inData, note: band.note };
  }

  /* ---------- 系统寄生损失修正（工质泵 + 管路压降，2026-09-28 P1-1）----------
     效率表算的是"理想循环净输出"（泵等熵效率 0.80、忽略管道压损）。
     这一层把真实机组多付的两笔扣掉，得到**交付净效率**：
       ① 泵总效率（等熵×电机）远低于 0.80，小机组尤其低；
       ② 管路/换热器/阀门压降要额外加压升。
     公式、实测锚点与诚实性边界见 src/engine/parasitic.js 头部说明；
     量级：10 kW 级 ORC 扣 0.6~1.1 个百分点、5 MW 级扣 0.1~0.2 个百分点。 */
  function netEffPct(path, tSrc, qKw, dT) {
    const P = window.WHPARASITIC;
    let e0 = null, tDesign = null, kind = null;
    if (path === "orc") {
      /* ⚠ 2026-10-09（P5 补漏）：守卫必须盖住**每一个**入口，不只是场景版入口。
         我第一版只改了 orcEfficiencyForScene，结果本探针走 netEffPct 仍能在 40℃
         拿到 1.5334%（因为它直接落到 orcNetEffByEvap，绕过了可行性前置）。
         这里补同一道前置：不可行就返回 null，而不是靠 clamp 给一个正值。 */
      if (!orcFeasible({ "热源温度_degC": tSrc, "换热端差_degC": dT }).ok) return null;
      return orcNetEffByEvap(orcDesignEvapTemp(tSrc, dT || 0), qKw);
    } else if (path === "steam_pp") {
      e0 = steamEffPct(tSrc); kind = "steam";
      tDesign = clamp(Number(tSrc) - 100.0, 180.0, 540.0);
      /* 2026-10-09：先把"固定 eta_t=0.7891"换成容量相关的蒸汽轮机等熵效率曲线，
         再扣寄生损失（顺序：修正透平 → 扣泵与压降；两者证据来源不同，不重复扣） */
      const capSteam = Math.max(Number(qKw) * e0 / 100.0, 1e-6);
      e0 = e0 * steamEtaFactor(capSteam);
      /* ⚠ 2026-10-13（P0-1，复核方拍板"改"）：这里**原来漏了发电机+机械效率**。
         为什么必须补：
           ① 与 ORC 不对称 —— ORC 三处（settle 见 orcNetEffByEvap）都乘了，且自己标了
              `generatorEtaIncluded: true`；蒸汽链路 6 个函数**一次都没调用** generatorEta。
           ② **与本文件登记的口径不一致** —— 《口径字典》写的蒸汽侧定义是
              "**蒸汽朗肯净电 ÷ 回收热**"，而"净电"＝发电机端；不乘就是不扣发电机损失。
           ③ 不会重复扣 —— 蒸汽表来自 CoolProp 朗肯扫描（net = W_exp − W_pump，**纯循环净功**），
              容量系数来自 DCS **等熵**口径（也是透平侧）⇒ 表里没有折叠发电机效率。
         口径：**与 ORC 同规矩** —— 规模/发电机/寄生三层共用**同一个从表值出发的 capSteam**，
              再 `e0×容量系数×genEta − 寄生`；寄生那一步用的功率由下面共用的 cap0 重算（= 修正后功率）。
         量级：MW 级 −5.0~5.3%；0.06 MW 档（genEta 0.8853）−12~13%。 */
      e0 = e0 * generatorEta(capSteam);
    } else return null;
    if (e0 === null || e0 === undefined) return null;
    if (!P || !P.hasTable(kind)) return e0;
    const cap0 = Math.max(Number(qKw) * e0 / 100.0, 1e-6);
    const loss = P.lossPct(kind, tDesign, cap0);
    return e0 - loss;
  }

  /* 指定设计蒸发温度下的 ORC 交付净效率（%，已扣泵功与管路压降）——
     设计点扫描（P2-9）用这个入口。 */
  /* ---------- 两级/串级热水 ORC（2026-09-28 第六轮核验后接入）----------

     为什么必须有它：单压模型在海南炼化锚点上低估净功率 37%（模型 395 kW vs 实测年均
     632、考核 789~1022 kW）。第六轮拿到两台开山串级机组（R245fa）的逐级参数后，
     按"水先过高湿级、再过低湿级 + 逆流蒸发器冷端夹点"重建了两级模型
     （tools/two_stage_orc.py），并用 4 个实测点标定：

       夹点 5 K、透平等熵效率 0.80、泵等熵效率 0.75（现场标定值）、
       厂用电占毛功率 10%（第六轮 N3：Siemens 5~6%、Pamukuren 14.9%、Lahendong 18.8%）、
       空冷冷凝 approach 5 K

     四点偏差 −6.1%~+5.9%（RMS 5.0%）→ **那 37% 的低估主要来自结构（单压 vs 两级）**。

     表由 tools/two_stage_table.py 生成（输入 热源进口℃/源侧降温 K/冷凝℃，输出净效率 %，
     已含泵功与厂用电）。适用条件：热源 ≤170℃ 且源侧降温 ≥25 K；条件之外仍用单压表。 */
  const ORC2_MIN_SPAN = 25.0;
  const ORC2_MAX_TIN = 170.0;
  const ORC2_REF_ETA_T = 0.80;
  const ORC2_APPROACH_K = 5.0;

  let ORC2_IDX = null;
  function orc2Index() {
    if (ORC2_IDX !== null) return ORC2_IDX;
    const T = window.WHTWOSTAGE;
    const idx = {};
    if (T && T.rows) {
      for (let i = 0; i < T.rows.length; i++) {
        const r = T.rows[i];
        idx[r[0] + "|" + r[1] + "|" + r[2]] = r;
      }
    }
    ORC2_IDX = idx;
    return idx;
  }
  function orc2Row(tIn, span, tCond) {
    return orc2Index()[tIn + "|" + span + "|" + tCond] || null;
  }
  /* 三维查表（5 K 规则网格）；缺失点先挪冷凝温度、再挪降温程，仍缺返回 null */
  function twoStageEffPct(tInC, spanK, tCondC) {
    const tin = Math.round(Number(tInC) / 5) * 5;
    const span = Math.round(Number(spanK) / 5) * 5;
    const tc = Math.round(Number(tCondC) / 5) * 5;
    let row = orc2Row(tin, span, tc);
    if (!row) row = orc2Row(tin, span, tc - 5) || orc2Row(tin, span, tc + 5);
    if (!row) row = orc2Row(tin, span - 5, tc) || orc2Row(tin, span + 5, tc);
    if (!row) row = orc2Row(tin - 5, span, tc) || orc2Row(tin + 5, span, tc);
    return row ? row[3] : null;
  }
  function orcTwoStageApplicable(tSrc, span) {
    return Number(tSrc) <= ORC2_MAX_TIN && Number(span) >= ORC2_MIN_SPAN;
  }
  /* 适用性（含载体限制）：标定的两台机组都是**热水**热源（118℃/100℃），
     所以只对液体载体、且热源 ≤140℃ 启用两级模型；烟气/更高温仍走单压表
     （宁可保守，也不把未验证的结论外推）。 */
  const ORC2_MAX_TIN_LIQUID = 140.0;
  function orcTwoStageUsable(scene, span) {
    const medium = scene["载体"];
    if (medium !== "热水·冷凝水" && medium !== "工艺液体") return false;
    return Number(scene["热源温度_degC"]) <= ORC2_MAX_TIN_LIQUID &&
           Number(span) >= ORC2_MIN_SPAN && Number(span) <= 70.0;
  }

  /* ---------- 冷源温度感知的单压表（2026-09-29，外部验证集查出来的问题）----------

     旧的一维效率表只按蒸发温度档取中位，**隐含冷凝温度落在 50~62℃**
     （异丁烷背压 0.5~0.7 MPa）。但液体热源的真实工程用冷却水/空冷，
     冷凝温度只有 30~40℃ —— 河南化肥厂 1.2 MW 机组就是这么运行的，
     实测热效率 12.1%，而旧表在同条件只给 8.41%（低估 30%）。

     用 CoolProp 按真实冷凝温度重算后（tools/orc_cond_table.py，蒸发 × 冷凝二维）：
     (115℃ 蒸发, 35℃ 冷凝) → 12.30%，与实测 12.1% 只差 1.6%。

     因此：**液体热源**改用二维表（按环境温度定冷凝温度）；
     气体热源仍用原一维表（那里的隐含冷凝温度没被验证过，维持原口径并登记局限）。 */
  let ORCCOND_IDX = null;
  function orcCondIndex() {
    if (ORCCOND_IDX !== null) return ORCCOND_IDX;
    const T = window.WHORCCOND;
    const idx = {};
    if (T && T.rows) {
      for (let i = 0; i < T.rows.length; i++) {
        const r = T.rows[i];
        idx[r[0] + "|" + r[1]] = r;
      }
    }
    ORCCOND_IDX = idx;
    return idx;
  }
  /* 二维（蒸发温度 × 冷凝温度）表查询。
     ⚠ 2026-10-09（DSH 复核 P4）——旧实现在查不到格子时会**静默把 tEvap ±5℃**，
     而且优先取 tEvap−5（方向偏乐观），调用方却仍按请求的 tEvap 做后续计算 → "答非所问"。
     现在钉死三条规矩：
       ① **绝不动 tEvap**（动了就是答非所问）；
       ② 只允许在 tCond 方向做一次 ±5 吸附，且结果必须落在表的实测区间内；
       ③ 吸附**必须暴露出来**（snappedFrom/snappedTo），供界面与文档标注，不藏。
     ⚠ 已知边界：环境温度高时算出的 tCond（= 环境 + approach）会高于表覆盖上限，
       这时靠 tCond 吸附消化，属**外推**，对外表述要写"已吸附到表的上限"。 */
  let ORCCOND_BOUNDS = null;
  function orcCondBounds() {
    if (ORCCOND_BOUNDS) return ORCCOND_BOUNDS;
    const idx = orcCondIndex();
    let teLo = 1e9, teHi = -1e9, tcLo = 1e9, tcHi = -1e9;
    Object.keys(idx).forEach(function (k) {
      const a = String(k).split("|"), te = Number(a[0]), tc = Number(a[1]);
      if (isNaN(te) || isNaN(tc)) return;
      if (te < teLo) teLo = te;
      if (te > teHi) teHi = te;
      if (tc < tcLo) tcLo = tc;
      if (tc > tcHi) tcHi = tc;
    });
    ORCCOND_BOUNDS = { teLo: teLo, teHi: teHi, tcLo: tcLo, tcHi: tcHi };
    return ORCCOND_BOUNDS;
  }
  /* 返回 { p50, tEvap, tCond, snappedFrom, snappedTo, bounds }；查不到 p50=null */
  function orcCondLookup(tEvapC, tCondC) {
    const te = Math.round(Number(tEvapC) / 5) * 5;
    const tc = Math.round(Number(tCondC) / 5) * 5;
    const idx = orcCondIndex(), b = orcCondBounds();
    let row = idx[te + "|" + tc], snapped = null;
    if (!row) {
      const cand = [tc - 5, tc + 5].filter(function (v) { return v >= b.tcLo && v <= b.tcHi; });
      for (let i = 0; i < cand.length && !row; i++) {
        row = idx[te + "|" + cand[i]];
        if (row) snapped = { from: tc, to: cand[i] };
      }
    }
    return { p50: row ? row[3] : null, tEvap: te, tCond: snapped ? snapped.to : tc,
             snappedFrom: snapped ? snapped.from : null,
             snappedTo: snapped ? snapped.to : null, bounds: b };
  }
  /* 返回 P50（kW 净输出/MW 回收热）或 null（保持旧签名，内部走 orcCondLookup） */
  function orcCondP50(tEvapC, tCondC) { return orcCondLookup(tEvapC, tCondC).p50; }
  function orcCondUsable(scene, tEvapC, tCondC) {
    const medium = scene["载体"];
    if (medium !== "热水·冷凝水" && medium !== "工艺液体") return false;
    const te = Number(tEvapC);
    if (!(te >= 60 && te <= 170)) return false;
    /* 冷凝温度越界校验（2026-10-09，P4）：允许 +5 的吸附余量，超过就判越界 */
    if (tCondC !== undefined && tCondC !== null) {
      const b = orcCondBounds();
      const tc = Number(tCondC);
      /* ⚠ 2026-10-10 修 bug：原写成 `tc < b.tcLo`（**只给上沿留了吸附余量**），
         于是 tCond 低于表下限时被**直接拒绝**而不是吸附 —— 实测打断的是
         `anchor_reconciliation.js` 的 Chena 锚点：那里按阿拉斯加气候设 `ambient: 10`，
         tCond = 15℃，低于二维表下限 20℃，旧代码会把它吸附到 20℃ 用二维表（→ −18.7%），
         我这一条却把它毙掉、退回一维表（→ 打印 −68%）。
         正确做法：**两侧都给 ±5 的吸附余量**，与 orcCondLookup 的吸附方向一致。 */
      if (b && b.tcHi > 0 && (tc < b.tcLo - 5 || tc > b.tcHi + 5)) return false;
    }
    return true;
  }

  /* 统一的 ORC 效率入口（场景版）：自动在"两级"与"单压"之间选。
     返回 { effPct, design, spanK, tCondC, ... } 或 null。 */
  /* ---- 效率区间（2026-09-29，对应 M1 可实现性校正层的落地）----

     为什么需要：我们所有对外数字都是**点值**，但最不确定的那条假设是"膨胀机等熵效率"。
     M1M2 用真实机队给出了三档基准（Landelle 去重后 48 台，有等熵效率的 16 台）：

       · 跨机队中位 **0.50**（16 台，含大量小试验台）——只作最悲观下界参照；
       · **R245fa 商用机队中位 0.72**（6 台）——本模型取它作"下沿"；
       · 内核隐含等效值 0.7897 / 两级模型标定值 0.80——主口径；
       · 效率表扫描上界 **0.90**——上沿。

     换算方式：对同一循环，热效率近似与 η_t 成正比（泵功占比小），
     所以 下沿 = 主口径 × (0.72/参考η_t)、上沿 = 主口径 × (0.90/参考η_t)。
     参考 η_t：单压表用 0.7897（反解值），两级模型用 0.80（标定值）。 */
  const ETA_T_LOW = 0.72;      // R245fa 商用机队中位（M1M2/Landelle）
  const ETA_T_HIGH = 0.90;     // 效率表扫描上界
  function orcEffRange(d) {
    if (!d) return null;
    const ref = d.design === "two-stage" ? ORC2_REF_ETA_T : ETA_T_REF;
    /* 装置效应带宽（2026-09-29，回应 E2 的负结果）：
       590 点实测显示，实现率的最大/最小倍数中位是 6.25×，且**装置级效应是主导因素**
       （工质只解释 9.1%、规模 20.7%）。所以除了"η_t 假设带"，还要报一条
       **跨装置实测带宽**：RR 的 P10/P90 = 0.291/0.667，相对中位 0.491 即 ×0.593 / ×1.358。
       这条带宽**用于风险沟通**（"换一台机器可能差这么多"），不是预测区间。 */
    const DEV_LOW = 0.593, DEV_HIGH = 1.358;
    return {
      mid: d.effPct,
      low: d.effPct * (ETA_T_LOW / ref),
      high: d.effPct * (ETA_T_HIGH / ref),
      refEtaT: ref,
      deviceLow: d.effPct * DEV_LOW,
      deviceHigh: d.effPct * DEV_HIGH,
      deviceNote: "跨装置实测带宽（590 点 RR 的 P10~P90，相对中位 ×0.59~×1.36）"
    };
  }

  function orcEfficiencyForScene(scene, qKw) {
    const tS = Number(scene["热源温度_degC"]);
    const dT = Number(scene["换热端差_degC"]);
    /* ⚠ 2026-10-09（DSH 复核 P5）：可行性前置。
       旧行为：orcDesignEvapTemp 把蒸发温度 clamp 到 [60,350]，于是热源 40~70℃
       也会"算"出一个 60℃ 蒸发 + 5 K 可用降温 + 正效率（实测 40/50/60/70℃ 全给
       2.3756%），等于**用一个比热源还冷的蒸发器回收热**——与 D1 查出的
       "280℃ 是数据覆盖下限被写成规则"完全同型，只是这次在 ORC 侧。
       现在：不满足最小传热温差就不给值，返回 null（该路径直接不进候选），
       并由 boundaryNotices 给出可见提示。 */
    if (!orcFeasible(scene).ok) return null;
    const span = Math.max(tS - orcEvapTemp(scene) - dT, 5.0);
    const tCond = ambientC() + ORC2_APPROACH_K;
    const scale = PRICES.effScale === undefined ? 1.0 : PRICES.effScale;
    if (orcTwoStageUsable(scene, span) && orcTwoStageApplicable(tS, span)) {
      const e2 = twoStageEffPct(tS, span, tCond);
      if (e2 !== null) {
        const cap0 = Math.max(Number(qKw) * e2 / 100.0, 1e-6);
        /* f 为什么**保留**（2026-10-09 DSH 实测答复，免得下一个人再来问一遍）：
           4 个标定点（789 / 927 / 1022 / 1340 kW）处 turbineEtaOf = 0.8285~0.8371
           → f = min(1, η_t/0.80) ≡ **1.0000**，说明"标定值 0.80"与"规模修正"在标定范围内**正交**；
           f 仅在 cap < 137 kW 时才 <1（100 kW→0.9936、50→0.9796、10→0.9469），
           那是**真实的规模外推**（表里没有那小段数据），不是把发电机损失扣第二遍。 */
        const f = Math.min(1.0, turbineEtaOf(cap0) / ORC2_REF_ETA_T);
        const g = generatorEta(cap0);
        /* ⚠ 2026-10-09（DSH 复核 P1）：这里**不能再乘 g**。
           两级表 two_stage_table.js 的 meta 自述就是「净效率 %（已扣泵与厂用电）」，
           生成脚本 tools/two_stage_table.py 里是 net=(g1+g2)*(1-AUX)，
           而它用的透平等熵效率 0.80 又是拿海南炼化实测**净电功率**（789/927/1022 kW）标定的
           → 再乘一次发电机效率是**重复扣减**（8.2 kW 处 −21%、2 MW 处 −5%）。
           结构上还有一层：f 在 ≥200 kW 被 min(1.0,·) 夹成 1、g 恒 <1，
           于是引擎**永远取不到两级表自己的标定值**。所以改成 e2*f*scale；
           g 仍作为字段返回，仅供界面展示，标明"表内已含"。 */
        return { effPct: e2 * f * scale, design: "two-stage", spanK: span, tCondC: tCond,
                 tEvapC: null, sizeFactor: f, parasitic: 0.0,
                 generatorEta: g,
                 generatorEtaIncluded: true,
                 note: "两级/串级（R245fa，实测标定）；表已含厂用电与发电机损失，不再单乘 η_gen" };
      }
    }
    const tEvap = orcDesignEvapTemp(tS, dT);
    /* 液体热源：按真实冷源温度查二维表（2026-09-29） */
    if (orcCondUsable(scene, tEvap, tCond)) {
      const lk = orcCondLookup(tEvap, tCond);
      const p50 = lk.p50;
      if (p50 !== null) {
        const e0 = p50 / 10.0;                       // kW/MW → %
        const cap0 = Math.max(Number(qKw) * e0 / 100.0, 1e-6);
        const f = Math.min(1.0, turbineEtaOf(cap0) / ORC2_REF_ETA_T);
        const g = generatorEta(cap0);
        const P = window.WHPARASITIC;
        const loss = (P && P.hasTable("orc"))
          ? P.lossPct("orc", clamp(tEvap, 60, 360), cap0) : 0.0;
        return { effPct: (e0 * f * g - loss) * scale, design: "cond-aware",
                 spanK: span, tCondC: tCond, tEvapC: tEvap,
                 tCondUsedC: lk.tCond,
                 tCondSnappedFrom: lk.snappedFrom, tCondSnappedTo: lk.snappedTo,
                 sizeFactor: f, parasitic: loss, generatorEta: g,
                 note: "单压（按真实冷源 " + tCond.toFixed(0) + "℃ 查二维表" +
                   (lk.snappedFrom !== null ? "；⚠ 已吸附到表上限 " + lk.snappedTo + "℃" : "") + "）" };
      }
    }
    let eff = orcEffByEvapTemp(tEvap);
    if (eff === null) return null;
    const cap0 = Math.max(Number(qKw) * eff / 100.0, 1e-6);
    const f = turbineSizeFactor(cap0);
    const g = generatorEta(cap0);
    const P = window.WHPARASITIC;
    const loss = (P && P.hasTable("orc")) ? P.lossPct("orc", clamp(tEvap, 60, 360), cap0) : 0.0;
    return { effPct: (eff * f * g - loss) * scale, design: "single", spanK: span, tCondC: tCond,
             tEvapC: tEvap, sizeFactor: f, parasitic: loss, generatorEta: g,
             note: "单压（标定表 + 系统寄生损失）" };
  }

  /* ---- 规模维度：膨胀机效率随机组变小而下降（2026-09-28，P2-6）----

     原来的代理模型没有"规模"输入：效率表来自固定 η_t ∈ {0.70…0.90} 的均匀网格，
     其隐含的等效膨胀机等熵效率是 **0.7897**（M1M2 二分反解值，见
     `M1M2/results/回灌决策内核_膨胀机效率影响.md`）。而真实机组的膨胀机效率是随
     规模变的——Landelle 实验 ORC 数据库（CC BY 4.0）38 台有 η_t 与发电功率的机组拟合：

         η_t(P) = 0.720 + 0.037 · log10(P[kW])       （P = 净电功率）
         分档实测中位：≤1 kW 0.700（n=12）、1~5 kW 0.764（n=18）、
                       5~20 kW 0.710（n=5）、20~100 kW 0.685（n=3）

     本层只用**保守方向**：correction = min(1, η_t(P)/0.7897)
     → 1 kW 0.91、5 kW 0.94、20 kW 0.97、≥100 kW 1.00（不给大机组加成，
       因为 >100 kW 没有实验数据可依）。 */
  const ETA_T_REF = 0.7897;
  /* ---- 发电机 + 机械效率（2026-09-29，A2）----

     效率表给的是"透平轴功 − 泵功"，而真实交付的是**发电机端净电功率**，
     中间还有发电机与机械损失。第七轮 R2-1 的 76 点实测给了直接证据：
     **扭矩功 ÷ 焓降功中位 0.697**（0.3 kW 级小机组），即小机的发电机+机械损失吃掉约 30%。
     MW 级发电机的效率一般在 0.95~0.97。

     按规模插值（对数）：0.5 kW→0.70、5 kW→0.80、50 kW→0.88、200 kW→0.92、≥1 MW→0.95。
     ⚠ 这一项**只作用于发电类路径**（ORC/蒸汽/储能发电），热泵与制冷另有各自的效率口径。 */
  const GEN_ETA_CURVE = [[0.5, 0.70], [5.0, 0.80], [50.0, 0.88],
                         [200.0, 0.92], [1000.0, 0.95]];
  function generatorEtaBase(capKw) {
    const p = Math.max(Number(capKw) || 0, 0.1);
    const c = GEN_ETA_CURVE;
    if (p <= c[0][0]) return c[0][1];
    if (p >= c[c.length - 1][0]) return c[c.length - 1][1];
    for (let i = 0; i < c.length - 1; i++) {
      if (p >= c[i][0] && p <= c[i + 1][0]) {
        const f = (Math.log10(p) - Math.log10(c[i][0])) /
                  (Math.log10(c[i + 1][0]) - Math.log10(c[i][0]));
        return c[i][1] + (c[i + 1][1] - c[i][1]) * f;
      }
    }
    return c[c.length - 1][1];
  }
  /* 发电机/机械效率的工程取值可被扰动（2026-10-09）：
     0.5 kW→0.70 有 76 点实测支撑，但 MW 级 0.95 是**工程取值**（无实测），
     所以让它可调，证书里扰动它，看推荐会不会因此翻转。 */
  function generatorEta(capKw) {
    const s = PRICES.genEtaScale === undefined ? 1.0 : Number(PRICES.genEtaScale);
    return Math.min(0.995, generatorEtaBase(capKw) * s);
  }
  /* ---- 膨胀机部件图谱（A5，2026-09-29）----

     图谱来自实测（R245fa 1 kW 台架 77 点 + 列日/MM/MDM 锚点），口径是**轴端等熵效率**，
     按轴功率档给中位：0.05~0.1 kW→0.29、0.1~0.25→0.50、0.25~0.5→0.576、0.5~1.5→0.591。

     怎么用（**避免与发电机效率重复扣减**）：
       我们链路是「效率表(过程口径) × 规模系数 × 发电机效率 = 电输出」。
       图谱给的是**轴端**口径，所以要反推成过程口径的上限：
            过程等效上限 = 图谱轴端效率 ÷ 发电机效率
       再除以参考 η_t（0.7897）得到"规模系数"的上限，取与规模曲线的**较保守者**。

     诚实结论：对小机组段，图谱算出的上限**比现有规模曲线更宽松**（发电机效率已经把
     机械损失算进去了）→ **实际不改数值**；它真正的价值是把"自由假设"换成实测数据，
     并在极小型机组（<0.1 kW）处提供约束。 */
  function expanderMapEta(pShaftKw) {
    const M = window.WHEXPANDER;
    if (!M || !M.bands || !M.bands.length) return null;
    const p = Number(pShaftKw);
    for (let i = 0; i < M.bands.length; i++) {
      const b = M.bands[i];
      if (p >= b[0] && p < b[1]) return b[2];
    }
    return null;          // 超出图谱覆盖（>1.5 kW）：不外推，交给规模曲线
  }
  function turbineEtaOf(capKw) {
    const M = window.WHTURBINE_SIZE;
    const p = Math.max(Number(capKw) || 0, 1e-3);
    if (M && M.meta && M.meta.fit) {
      const v = M.meta.fit.intercept + M.meta.fit.slope * Math.log10(p);
      return Math.min(Math.max(v, 0.55), 0.90);
    }
    return ETA_T_REF;
  }
  function turbineSizeFactor(capKw) {
    const curve = Math.min(1.0, turbineEtaOf(capKw) / ETA_T_REF);
    /* ⚠ 2026-10-09（DSH 复核 P6g）：图谱 expander_map.js 的档位口径是**轴功率**，
       而这里传进来的 capKw 是**净电功率** ⇒ 必须先除以发电机效率换算。
       影响方向：传净电功率会查到**更低**的档 ⇒ 偏保守（宁可低估）；
       而且只在 <1.5 kW 电功率时才可能命中 ⇒ 属**潜伏错**，不是当前算错
       （实测 ORC 路径最小装机 ≈33.5 kW，图谱恒返回 null、恒走规模曲线）。
       修它的理由是"契约要真"，不是为了改数。 */
    const mapShaft = expanderMapEta(capKw / generatorEta(capKw));
    if (mapShaft === null) return curve;
    const procEquiv = mapShaft / generatorEta(capKw);   // 轴端 → 过程口径上限
    const mapCap = Math.min(1.0, procEquiv / ETA_T_REF);
    return Math.min(curve, mapCap);                     // 只做减法：取更保守的那个
  }

  function orcNetEffByEvap(tEvapC, qKw) {
    const e0 = orcEffByEvapTemp(tEvapC);
    if (e0 === null || e0 === undefined) return null;
    /* 先按规模折膨胀机效率，再扣系统寄生损失（两者的规模依赖来自不同证据：前者实测
       机组效率、后者实测泵功与压降） */
    const cap0 = Math.max(Number(qKw) * e0 / 100.0, 1e-6);
    const eSize = e0 * turbineSizeFactor(cap0);
    const P = window.WHPARASITIC;
    if (!P || !P.hasTable("orc")) return eSize;
    return eSize - P.lossPct("orc", clamp(Number(tEvapC), 60, 360), cap0);
  }
  /* 修正量本身（百分点），供界面/文档展示 */
  function parasiticPct(path, tSrc, qKw, dT) {
    const raw = path === "orc" ? orcEffPct(tSrc, dT || 0) : steamEffPct(tSrc);
    const net = netEffPct(path, tSrc, qKw, dT);
    if (raw === null || net === null) return null;
    return raw - net;
  }

  // ---------- 减排/成本 ----------
  function heatRedGas(scene, penalty) {
    const q = recoveredHeatKw(scene);
    const heatGj = q * Number(scene["年运行小时"]) * 3.6 / 1000.0;
    return heatGj * GAS_EF / BOILER_EFF / (penalty || 1.0);
  }

  /* 储热类的减排量：随收益口径切换（2026-09-28 P1-4）。
     口径 A（售热/替代燃料）：与直接换热同口径 = 回收热替代天然气锅炉；
     口径 B（峰谷套利）：替代的是**峰段电加热**，减排按电网因子算
        （少买的电量 = 放热量 ÷ 电加热效率）；叠加口径按 A 计（保守）。
     年吞吐量同样按峰段等效放电小时计，避免用 6,000 h 把减排量放大 4 倍。 */
  function storageReduction(scene) {
    const sh = storageHoursOf(Number(scene["年运行小时"]));
    const eff = 0.75;                                   // 相变储放热效率（与能效列一致）
    /* 充热耗电的排放：谷电充热时要从替代量里扣掉（否则等于说"用电充热却不排碳"）。
       余热直接充热（storageCharge = waste）时充热侧不计排放。 */
    const chargeCo2 = storageChargeMode() === "valley"
      ? (1.0 / eff) * sh * 1000.0 * GRID_EF / 1000.0 : 0.0;
    if (storageRevenueMode() === "arbitrage") {
      const mwhEl = sh * 1000.0 / ELEC_HEAT_ETA / 1000.0;   // MWh 电
      const avoided = mwhEl * GRID_EF;
      return Math.max(avoided - chargeCo2, 0.0);
    }
    const q = recoveredHeatKw(scene);
    const heatGj = q * sh * 3.6 / 1000.0;
    return Math.max(heatGj * GAS_EF / BOILER_EFF - chargeCo2, 0.0);
  }

  function steamDrivenAbsReduction(scene) {
    return heatRedGas(scene, 1.0) * (1.0 - 1.0 / COP_H_ABS_EXT);
  }

  function steamDrivenAbsOpexWanMw(scene) {
    const hours = Number(scene["年运行小时"]);
    return (1.0 / COP_H_ABS_EXT) * hours * 3.6 * STEAM_PRICE / 10000.0 * STEAM_OPS_FACTOR;
  }

  function coolingAbsReduction(scene) {
    const cop = absCoolCop(Number(scene["热源温度_degC"])) || COP_C_ABS;
    const qCold = cop * recoveredHeatKw(scene);
    const mwhAvoided = qCold / chillerCop() * Number(scene["年运行小时"]) / 1000.0;
    return mwhAvoided * GRID_EF;
  }

  function compCoolOpexWanMw(scene) {
    return (1.0 / chillerCop()) * Number(scene["年运行小时"]) * elecPrice() * 1000.0 / 10000.0;
  }

  function compReduction(scene, cop) {
    const c = cop || (compCopFor(scene) || {}).cop || HP_COP;
    const q = recoveredHeatKw(scene);
    const heatGj = q * Number(scene["年运行小时"]) * 3.6 / 1000.0;
    const elecMwh = heatGj / 3.6 / c;
    return Math.max(heatGj * GAS_EF / BOILER_EFF - elecMwh * GRID_EF, 0.0);
  }

  function powerReduction(path, scene) {
    /* 发电类减排也要用它自己的回收热口径（与装机容量、回收期同一口径） */
    const q = qForPath(path, scene, recoveredHeatKw(scene));
    const hours = Number(scene["年运行小时"]);
    let e = null;
    if (path === "orc") {
      const d = orcEfficiencyForScene(scene, q);
      e = d ? d.effPct : null;
    } else if (path === "steam_pp") {
      e = netEffPct(path, Number(scene["热源温度_degC"]), q, Number(scene["换热端差_degC"]));
    }
    else if (path === "teg") e = tegEffPct(scene);   // TEG 效率随温差（第七轮 R5-3）
    else return 0.0;
    if (!e) return 0.0;
    const mwh = (e / 100.0) * q * hours / 1000.0;
    return mwh * GRID_EF;
  }

  function buildMatrixV2(survivors, scene) {
    const X = survivors.map((p) => BASE_INDICATORS[p].slice());
    const q = recoveredHeatKw(scene);
    const hours = Number(scene["年运行小时"]);
    const demand = scene["需求"];
    /* 电制冷 COP 随环境温度（2026-09-29）：每轮按当前场景/环境参数刷新一次，
       供容量、运行成本、替代电耗与减排量共用同一个值。 */
    CHILLER_COP = electricChillerCop(scene);
    /* 压缩式热泵的 COP 随温度算（见 compCopFor）；其余路径不受影响 */
    const compInfo = compCopFor(scene);
    const compCop = compInfo ? compInfo.cop : null;
    for (let i = 0; i < survivors.length; i++) {
      const p = survivors[i];

      // ---- 第 1 步：先定能效（装机容量要用它，所以顺序不能颠倒）----
      if (p === "orc") {
        /* 2026-09-28：能效列改用**交付净效率**（已扣泵功与管路压降的系统寄生损失），
           这样装机容量、发年电量、减排量与回收期全部是"到用户手上的净输出"口径 */
        /* 并且自动在"两级/串级"与"单压"之间选（第六轮核验后接入，2026-09-28） */
        const d = orcEfficiencyForScene(scene, orcRecoveredKw(scene));
        if (d) X[i][0] = pyRound(d.effPct, 2);
      } else if (p === "steam_pp") {
        const e = netEffPct("steam_pp", Number(scene["热源温度_degC"]), steamRecoveredKw(scene), Number(scene["换热端差_degC"]));
        if (e !== null && e !== undefined) X[i][0] = pyRound(e, 2);
      } else if (p === "abs_self") {
        /* 二类（升温型）用连续曲线：COP 随驱动温度与温升变化（2026-09-28 P1-3） */
        const cop = demand === "工艺蒸汽"
          ? absIICop(Number(scene["热源温度_degC"]), compSupplyTemp(scene))
          : COP_I_ABS_SELF;
        X[i][0] = pyRound(cop * 100.0, 2);
      } else if (p === "abs_ext") {
        X[i][0] = pyRound(COP_H_ABS_EXT * 100.0, 2);
      } else if (p === "abs_cool") {
        const cop = absCoolCop(Number(scene["热源温度_degC"])) || COP_C_ABS;
        X[i][0] = pyRound(cop * 100.0, 2);
      } else if (p === "teg") {
        /* TEG 效率随温差（第七轮 R5-3）：原来固定 5%，实测 ΔT=100 K 只有 2.5% */
        X[i][0] = pyRound(tegEffPct(scene), 2);
      } else if (p === "comp_cool") {
        X[i][0] = pyRound(chillerCop() * 0.38 * 100.0, 2);
      } else if (p === "comp" && compCop) {
        /* 能效列沿用台账口径：一次能源效率 = COP × 电网效率 38% */
        X[i][0] = pyRound(compCop * 0.38 * 100.0, 2);
      }

      // ---- 第 2 步：规模档按"该路径自己的装机产出"定，不再一律按可回收热 ----
      // 投资列的单位是"每 MW 装机产出"（台账 §4 引文：ORC 23800 元/kW 装机），
      // 所以规模分档也必须用同一个量。以前用可回收热量分档，等于给发电类
      // 路径多打了一次折扣（ORC 约 0.83 倍、蒸汽朗肯约 0.70 倍）。
      // 2026-09-27 证据链体检 B2 项。
      /* 发电类各用自己的设计降温程算回收热（2026-09-27）：容量、投资规模、
         减排与回收期全部跟着走，避免"一个 q 套所有路径"的自相矛盾 */
      const cap = capacityKw(p, qForPath(p, scene, q), X[i][0], compCop);
      const sf = scaleMultiplier(p, scaleBand(cap));
      /* investScale 只给"决策证书"的扰动测试用（默认 1.0） */
      const invS = PRICES.investScale === undefined ? 1.0 : PRICES.investScale;
      X[i][1] = BASE_INDICATORS[p][1] * sf * invS;
      X[i][2] = BASE_INDICATORS[p][2] * sf * invS;
      X[i][5] = BASE_INDICATORS[p][5] * (p === "comp" ? 1.0 : sf) * invS;
      // 有出处的路径：回收期改成公式现算（见 paybackYears）。
      // 无出处的路径保留工程估算/示意值，但那个值只用于展示，不参与排序。
      if (ECON_GRADE[p] === "sourced") {
        const pb = paybackYears(p, X[i][1], hours, compCop, demand);
        X[i][2] = (pb === null) ? NO_PAYBACK_YEARS : pyRound(pb, 2);
      }

      // ---- 第 3 步：减排与运行成本的动态覆盖（公式与原实现一致）----
      if (p === "abs_self") {
        const redFactor = demand === "工艺蒸汽"
          ? absIICop(Number(scene["热源温度_degC"]), compSupplyTemp(scene)) : 1.0;
        X[i][3] = pyRound(heatRedGas(scene) * redFactor, 1);
      } else if (p === "abs_ext") {
        X[i][3] = pyRound(steamDrivenAbsReduction(scene), 1);
        X[i][5] = pyRound(steamDrivenAbsOpexWanMw(scene), 1);
      } else if (p === "abs_cool") {
        X[i][3] = pyRound(coolingAbsReduction(scene), 1);
      } else if (p === "comp_cool") {
        X[i][3] = 0.0;
        X[i][5] = pyRound(compCoolOpexWanMw(scene), 1);
      } else if (p === "comp") {
        X[i][3] = pyRound(compReduction(scene, compCop), 1);
        /* 运行成本＝自耗电成本，用电耗率 1/COP 算（原来是写死的 0.357，对应 COP2.8） */
        X[i][5] = pyRound((1.0 / (compCop || HP_COP)) * hours * elecPrice() * 1000 / 10000, 1);
      } else if (p === "tc_storage" || p === "pcm_storage") {
        /* 储热类：运行成本改为按谷电充电成本现算（见 energyCostWanMw）
           成本口径 2026-09-27：原来用工程估算常数（28 / 25 万元/MW·年）。
           注意：本分支在下面的减排分支之前，必须同时补上减排列，
           否则 else-if 链会让储热路径的减碳留在基准值 0（曾犯此错）。 */
        X[i][5] = pyRound(energyCostWanMw(p, hours, null, demand), 1);
        X[i][3] = pyRound(storageReduction(scene), 1);
      } else if (p === "direct" || p === "whb_steam") {
        X[i][3] = pyRound(heatRedGas(scene), 1);
        /* 运行成本＝输配电耗（2026-09-28 第六轮 N4）。以前这两条路径的运行成本列
           直接沿用台账基值（6 万元/MW·年），与"泵把热送出去"的真实成本无关。 */
        X[i][5] = pyRound(energyCostWanMw(p, hours, null, demand), 1);
      }
    }
    for (let i = 0; i < survivors.length; i++) {
      const p = survivors[i];
      // TEG 也是发电路径，减排列以前整条漏算 → 恒显示 0，
      // 等于对外说"TEG 不减排"，是假数（2026-09-27 证据链体检）。
      if (p === "orc" || p === "steam_pp" || p === "teg") {
        X[i][3] = pyRound(powerReduction(p, scene), 1);
      }
      /* 输配电耗的排放（第六轮 N4，2026-09-28）：产热类路径要把"把热送到用户"这份电
         算进去——以前只算产热侧的替代量，等于假设热自己会走到用户那里。
         口径：3.43 kWh/GJ（国内热力站实测均值）；储热按峰段放电小时计。 */
      const HEAT_PATHS = ["direct", "whb_steam", "tc_storage", "pcm_storage",
                          "abs_self", "abs_ext", "comp"];
      if (HEAT_PATHS.indexOf(p) >= 0) {
        const sh = (p === "tc_storage" || p === "pcm_storage")
          ? storageHoursOf(hours) : hours;
        const ded = heatTransportCo2(qForPath(p, scene, q), sh, demand);
        X[i][3] = pyRound(Math.max(X[i][3] - ded, 0.0), 1);
      }
    }
    return X;
  }

  // ---------- 权重 / TOPSIS（与 app.py combined_weights/topsis 一致）----------
  // meta: { names:[], sub:[], obj:[] }（eval_weights.json 原样）
  const MAP_IDX = { "系统能效": 0, "初始投资": 3, "投资回收期": 4, "CO2当量减排": 5, "政策补贴适配度": 7 };

  function weight6From(arr, names) {
    const pick = (k) => arr[names.indexOf(k)];
    const w = [pick("系统能效"), pick("初始投资"), pick("投资回收期"),
      pick("CO2当量减排"), pick("政策补贴适配度"),
      0.25 * (pick("初始投资") + pick("投资回收期"))];
    const s = w.reduce((a, b) => a + b, 0);
    return w.map((v) => v / s);
  }

  function entropyWeights(X) {
    const n = X.length, m = X[0].length;
    // 单候选时熵权在数学上无定义（ln1 = 0 → 0/0 = NaN）。以前不拦：
    // 供冷场景只剩吸收式一条路时权重整列 NaN，界面 λ 敏感性曲线画不出来。
    // 退回等权（此时排序本来也只有一条路，贴近度按约定取 1）。
    if (n <= 1) return X[0].map(function () { return 1.0 / m; });
    const xmin = [], xmax = [];
    for (let j = 0; j < m; j++) {
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < n; i++) { a = Math.min(a, X[i][j]); b = Math.max(b, X[i][j]); }
      xmin.push(a); xmax.push(b);
    }
    const xr = X.map((r) => r.map((v, j) => {
      const span = xmax[j] - xmin[j];
      if (span < 1e-12) return 1.0;
      return DIRECTIONS[j] === "max" ? (v - xmin[j]) / span : (xmax[j] - v) / span;
    }));
    const sumc = [];
    for (let j = 0; j < m; j++) sumc.push(xr.reduce((a, r) => a + r[j], 0) + 1e-10);
    const p = xr.map((r) => r.map((v, j) => (v + 1e-10) / sumc[j]));
    const e = [];
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += p[i][j] * Math.log(p[i][j]);
      e.push(-s / Math.log(n));
    }
    const es = e.reduce((a, b) => a + (1 - b), 0);
    return e.map((v) => (1 - v) / es);
  }

  function combinedWeights(lam, X, meta) {
    const wSub6 = weight6From(meta.sub, meta.names);
    const wObj6 = X ? entropyWeights(X) : weight6From(meta.obj, meta.names);
    const wAll = wSub6.map((v, i) => lam * v + (1 - lam) * wObj6[i]);
    const s = wAll.reduce((a, b) => a + b, 0);
    return wAll.map((v) => v / s);
  }

  function topsis(matrix, weights) {
    if (matrix.length === 1) return [1.0];
    const norm = matrix.map((r) => r.map((v, j) => v / Math.sqrt(matrix.reduce((a, row) => a + row[j] * row[j], 0) + 1e-12)));
    const v = norm.map((r) => r.map((x, j) => x * weights[j]));
    const pos = [], neg = [];
    for (let j = 0; j < v[0].length; j++) {
      const col = v.map((r) => r[j]);
      pos.push(DIRECTIONS[j] === "max" ? Math.max.apply(null, col) : Math.min.apply(null, col));
      neg.push(DIRECTIONS[j] === "max" ? Math.min.apply(null, col) : Math.max.apply(null, col));
    }
    return v.map((r) => {
      const dp = Math.sqrt(r.reduce((a, x, j) => a + (x - pos[j]) * (x - pos[j]), 0));
      const dn = Math.sqrt(r.reduce((a, x, j) => a + (x - neg[j]) * (x - neg[j]), 0));
      return dn / (dp + dn + 1e-12);
    });
  }

  // ---------- 总入口 ----------
  function runDecision(scene, lam, meta) {
    /* 2026-10-11（C 类体检）：外部复核者直接调本函数时常常不传 meta，
       以前会在 combinedWeights 深处抛 "Cannot read properties of undefined (reading 'indexOf')"。
       现在：能从 window.HFDATA.meta 取就自动取；取不到就报**能看懂的错**，不要报 TypeError。 */
    if (!meta || !Array.isArray(meta.names) || meta.names.length === 0) {
      const fb = (typeof window !== "undefined" && window.HFDATA && window.HFDATA.meta) || null;
      if (fb && Array.isArray(fb.names) && fb.names.length) { meta = fb; }
      else {
        throw new Error("runDecision 需要 meta（形如 {names,sub,obj}）：请传 window.HFDATA.meta，或显式构造后再调。");
      }
    }
    const v = validateScene(scene);
    if (!v.ok) return { out_of_scope: true, message: v.error, warnings: [v.error], keys: [], labels: [], X: null, scene: null };
    const s = v.scene;
    const st = stage1(s);
    const keys = PATH_KEYS.filter((p) => st.keep[p]);
    if (!keys.length) {
      const msg = "无可行候选路径：" + PATH_KEYS.filter((p) => !st.keep[p]).map((p) => DISPLAY[p] + "：" + st.reasons[p]).join("；");
      return { out_of_scope: true, message: msg, warnings: [msg], keys: [], labels: [], X: null, scene: s };
    }
    const X = buildMatrixV2(keys, s);

    /* 排序用的矩阵与展示用的矩阵分开：
       展示用 X（含各路径自己的工程估算值）；
       排序用 Xrank —— 把"经济性待标定"路径的投资/回收期换成有出处路径的中位数，
       让没有出处的数字既不奖也不罚（证据链体检第 2 条）。
       有出处路径一个都没有时整列不动，避免把中位数做成常数。 */
    const Xrank = X.map((r) => r.slice());
    const srcIdx = keys.map((p, k) => (ECON_GRADE[p] === "sourced" ? k : -1))
      .filter((k) => k >= 0);
    /* 只在"候选里确实有有出处路径"时才做中性替换。
       为什么不无条件做：2026-09-27 实测过无条件版本 —— 数据中心供暖场景的候选
       （直接换热/压缩式热泵/储热×2）全部是工程估算，把经济性两列压平后，
       剩下能效/减碳/政策分/运行成本决定排序，结果反过来推荐"相变储热"，
       与真实工程（热泵）矛盾。说明经济性准则在这种场景里无法被其它准则替代，
       所以宁可保留工程估算值并在界面上标明"待标定"，也不强行剔除。 */
    if (srcIdx.length) {
      [1, 2].forEach((j) => {
        const vals = srcIdx.map((k) => X[k][j]).sort((a, b) => a - b);
        const med = vals[Math.floor(vals.length / 2)];
        keys.forEach((p, k) => {
          if (ECON_GRADE[p] !== "sourced") Xrank[k][j] = med;
        });
      });
    }

    const w = combinedWeights(lam, Xrank, meta);
    const c = topsis(Xrank, w);
    const order = keys.map((p, i) => ({ path: p, closeness: pyRound(c[i], 4), row: X[i] }))
      .sort((a, b) => b.closeness - a.closeness);
    const warnings = [];
    const q = recoveredHeatKw(s);
    if (q < 500 && order.some((o) => o.path === "steam_pp")) {
      warnings.push("可回收热功率仅约 " + Math.round(q) + " kW（小规模），蒸汽朗肯单位造价×" +
        scaleMultiplier("steam_pp", "小").toFixed(2) + "，经济性差，建议专项可行性评估，勿直接按推荐实施");
    }
    return {
      out_of_scope: false, message: "", warnings,
      keys, labels: keys.map((p) => DISPLAY[p]), X, scene: s,
      econGrade: keys.map((p) => ECON_GRADE[p] || "pending"),
      order, top: order[0].path, topLabel: DISPLAY[order[0].path],
      weights: w
    };
  }

  // ---------- C3.2 边界提示（decision_v2_ui.boundary_notices 移植）----------
  const BOUNDARY_HIGH_SENSITIVE = 5.0;
  const BOUNDARY_NOTICE_BAND = 10.0;
  const BOUNDARY_NEAR_BAND = 5.0;

  function boundaryNotices(res) {
    if (res.out_of_scope || !res.keys || !res.keys.length || !res.scene) return [];
    const s = res.scene;
    const t = Number(s["热源温度_degC"]);
    const dT = Number(s["换热端差_degC"]);
    const demand = s["需求"];
    const driver = s["驱动来源"] || "余热自驱动";
    const keys = {};
    res.keys.forEach((p) => { keys[p] = true; });
    const notes = [];
    /* ORC 不可行提示（2026-10-09，DSH 复核 P5）：过去 tEvap 被 clamp 到 60℃，
       热源 40~70℃ 也会给出正效率与"5 K 可用降温"；现在不可行就不进候选，这里显式说明。 */
    const orcFeas = orcFeasible(s);
    if (!orcFeas.ok && !keys.orc) {
      notes.push("⚠ ORC 路径不可用（可行性前置）：" + orcFeas.reason +
        "。这是数据边界被当成可用范围的老问题（与蒸汽侧 280℃ 同型），现已改为明确拒绝而不是给一个偏乐观的值。");
    }
    /* C2（2026-10-09）：TEG 的效率口径是"上界"，必须显式标注 */
    if (keys.teg) {
      notes.push("ℹ TEG 口径提示：它的转换效率按**单模块温差**（热源−环境）取曲线值，" +
        "而热量按**整段可用降温**计 —— 相当于假设每个模块都看到全段温差，属**上界**，不是逐段串联的真实值。" +
        "对外引用 TEG 的发电量时请带上这句。");
    }
    /* C3（2026-10-09，DSH 要求）：获胜路径若在"能效 / 投资 / 回收期"三项上都不如某个被它击败的候选，
       说明不同路径很可能用了**不同口径**（P2 病灶的典型症状）→ 必须在界面上报警。
       X 列顺序：0 能效%（max）· 1 投资万元/MW装机（min）· 2 回收期年（min）。 */
    if (res.order && res.order.length > 1) {
      const tr = res.order[0].row;
      const labelOf = {};
      res.keys.forEach((k, i) => { labelOf[k] = res.labels ? res.labels[i] : k; });
      const allWorse = res.order.slice(1).filter(function (o) {
        const r = o.row;
        return r[0] > tr[0] && r[1] < tr[1] && r[2] < tr[2];
      }).map(function (o) { return labelOf[o.path] || o.path; });
      if (allWorse.length) {
        notes.push("⚠ **口径失效报警**：获胜路径「" + (labelOf[res.top] || res.top) +
          "」在**能效、投资、回收期三项**上都不如被它击败的：" + allWorse.join("、") +
          " —— 这种「三项全差却获胜」通常是不同路径用了**不同口径**造成的（见 docs/2026-10-09-P2方案_发电类可用热口径统一.md），请人工复核后再据此决策。");
      }
    }
    if (demand === "供暖·热水") {
      const tDem = s["需求温度_degC"] || 60.0;
      const lo = Math.max(60.0, tDem + dT);
      const margin = t - lo;
      if (keys.direct && margin >= 0 && margin < BOUNDARY_NOTICE_BAND) {
        if (margin < BOUNDARY_HIGH_SENSITIVE) {
          notes.push("⚠ 边界工况提示（S2 型）：热源 " + t.toFixed(0) + "℃ 仅比直接换热下限 " + lo.toFixed(0) +
            "℃（需求 " + tDem.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）高 " + margin.toFixed(1) +
            "℃，温度/端差的小幅扰动即可让“直接换热”失效并转向热泵（鲁棒性核验：恰处下限的场景保持概率约 50%）。工程上建议预留 ≥5℃ 端差裕量，或按“直接换热优先 + 热泵兜底”双方案设计。");
        } else {
          notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 距直接换热下限 " + lo.toFixed(0) + "℃（需求 " +
            tDem.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）仅高 " + margin.toFixed(1) +
            "℃，处于较敏感区。请用全年最低热源温度与换热器衰减后的真实端差复核，预留 ≥5℃ 裕量，避免按理想工况定容。");
        }
      } else if (!keys.direct && margin >= -BOUNDARY_NEAR_BAND && margin < 0) {
        notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 距直接换热下限 " + lo.toFixed(0) + "℃（需求 " +
          tDem.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）还差 " + (-margin).toFixed(1) +
          "℃，当前直接换热不可行、推荐转向热泵；若现场实际端差可压缩（换热端差仍应 ≥5℃）或需求温度略低，直接换热路径可恢复，请以实测换热性能曲线为准后再定案。");
      }
    } else if (demand === "干燥") {
      const tDry = s["需求温度_degC"] || 100.0;
      const lo = Math.max(60.0, tDry + dT);
      const margin = t - lo;
      /* 气-气直换的低负荷带宽（2026-09-29 T-3；**依据 2026-10-11 更正**）：
         依据＝**三维热管 ε 相对衰减 0.813**（迎面风速 1.0→3.0 m/s，六排管，
         Buildings 2024, 14(2):355，开放获取），即 73.2% ＝ 90 × 0.813。
         ⚠ 旧文案引的「负荷率 45% 相对满负荷降 9.8%」出自梅山钢铁 0.814→0.734，
         该出处**查无、已弃用**（问题台账 L-12）——数字换了、这句话漏改，此处一并更正。
         间歇运行意味着长期处于低负荷段，故点名提示。 */
      if (keys.direct && isGasGasDirect(s)) {
        const r = directEffRange(s);
        notes.push("ℹ 能效口径提示（气-气直换）：本模型名义取 " + r.mid.toFixed(0) +
          "%（口径＝回收热 ÷ 可回收热，不是换热器效能 ε）。实测同设备 ε 相对满负荷衰减 " +
          "0.813（三维热管 0.75→0.61，迎面风速 1.0→3.0 m/s），故低负荷段建议按 " +
          r.low.toFixed(0) + "% 复核" +
          (r.lowLoad ? "；本场景标为**间歇**运行，属于低负荷高发情形，建议优先按 " + r.low.toFixed(0) + "% 定容。" : "。") +
    "（ε 实测点：三维热管 0.75→0.61（Buildings 2024,14(2):355，原文已核）；" +
    "原用的梅山钢铁 0.814→0.734 已弃用——出处查无，见问题台账 L-12）");
      }
      if (keys.direct && margin >= 0 && margin < BOUNDARY_NOTICE_BAND) {
        if (margin < BOUNDARY_HIGH_SENSITIVE) {
          notes.push("⚠ 边界工况提示（S2 型）：热源 " + t.toFixed(0) + "℃ 仅比干燥直接热风下限 " + lo.toFixed(0) +
            "℃（需求 " + tDry.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）高 " + margin.toFixed(1) +
            "℃，小幅扰动即可能让该路径失效并转向热泵烘干。建议预留 ≥5℃ 端差裕量，或按“直接换热优先 + 热泵兜底”双方案设计。");
        } else {
          notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 距干燥直接热风下限 " + lo.toFixed(0) + "℃仅高 " +
            margin.toFixed(1) + "℃，处于较敏感区，请用全年最低温度复核后预留 ≥5℃ 裕量。");
        }
      }
    } else if (demand === "供冷" && driver === "余热自驱动" && keys.abs_cool) {
      if (t < 85.0) {
        notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 处于吸收式制冷驱动下限区（80~84℃ 按 COP_c=0.6 保守核算），运行温度一旦波动至 " +
          ABS_COOL_T_MIN.toFixed(0) + "℃ 以下该路径将整体失效。建议按 ≥85℃ 设计点预留裕量，或对该温度段做全年运行小时分布校核后再定容。");
      }
    }
    return notes;
  }

  // 展示用细账（ORC/蒸汽朗肯 P10/P50/P90 与净功率/收益）
  /* ---------- 可审计决策证书（D2，2026-09-29）----------

     要解决的问题：模型给出一个"推荐"，但每个推荐背后都压着一串假设
     （电价、热价、年运行小时、效率、造价、输配电耗…）。用户真正该知道的是：
       **这条推荐依赖哪些假设、假设错了结论会不会变。**

     证书回答三件事：
       ① 有效域：推荐路径是否临近边界（沿用 boundaryNotices 的提示）；
       ② 假设清单：每条假设的取值、证据、等级；
       ③ 稳健性：对每条假设做双向扰动后重跑决策，报告 top-1 是否翻转。

     诚实性：扰动用的是**假设区间**，不是"随机数"；区间来源写在 detail 里。
     翻转率是"在我们自己这个模型下的结论稳定性"，不等于"现实中一定如此"。 */
  /* 假设清单（2026-10-11 扩到 16 条，P-4c）。
     ⚠ 2026-10-12 订正：原注释写"扩到 15 条"，而**下面这个数组实际是 16 条**（数给它自己看即可）；
        台账与材料都按 **16 条**登记（6 条原假设 ＋ 10 条新增）。**注释与数组不一致本身就是一处"对不上"。**
     为什么扩：探针实测发现**证书的「假设」面板与「扰动」面板原先是两套东西** ——
     有 12 条扰动没有对应的假设条目（其中 9 条是"工程取值/边界"级参数，有依据、有等级、多数真生效）。
     评委对着界面问"你扰动的这条，登记在哪条假设下"，原版答不上来。这是**口径不一致**，不是小瑕疵。
     ⚠ 并且按守则 §11「一个名字只许装一个物理量」，把原先混在一起的
       `hours`（既指场景年运行小时、又指供暖季等效上限）**拆成两行**：
       `hours`＝**场景自己填的年运行小时**；`heatHoursCap`＝**供暖季等效上限（钳位）**。 */
  const CERT_ASSUMPTIONS = [
    ["elec", "电价", "9 省官方代理购电到户价中位（到户价含输配/基金附加）", "A"],
    ["heatPrice", "热价", "7 份政府定价文件换算出工业蒸汽 75~108 元/GJ", "A-"],
    ["hours", "年运行小时（场景值）", "各场景自带；6 个真实项目等效满负荷小时区间 3 313~8 000 h（中位≈6 100）。**平台默认 6 500 h** 只用于缺值时兜底", "B"],
    ["heatHoursCap", "供暖季等效上限", "3 200 h＝供暖季等效小时上限；**只作用于「供暖·热水」需求**（其余需求不读它）", "工程口径"],
    ["heatAux", "供热输配电耗", "国内热力站实测均值 3.43 kWh/GJ（清华 2020 行业统计）", "A-"],
    ["deltaT", "换热端差", "场景面板默认 10 K；界面上可直接调，证书按 5 K / 20 K 两端扰动", "工程取值"],
    ["orcCooldown", "ORC 设计降温程", "两条可用工业实测锚点的中位 46.5 K（海南炼化 48、AKCA 45）", "B"],
    ["orcEff", "发电类效率（ORC/TEG）", "两级模型 4 点标定（RMS 5.0%）/ 单压表+寄生损失+规模修正", "B"],
    ["capex", "路径投资", "造价分级：A 级 3 条 / B 级 5 条 / C 级 4 条（C 级不作推荐依据）", "分级"],
    ["steamEta", "蒸汽轮机容量效率", "实测锚点段 ≥30 MW（30 MW 背压 61.70%、33 MW 凝汽 64.22%，DCS 等熵口径）；**<30 MW 无等熵实测，取区间 55%~80%、不外推幂律**", "实测 + 工程取值"],
    ["steamBound", "蒸汽朗肯候选边界", "数据覆盖边界 280℃。**参数是活的，但在工况库这 19 行范围内无差别**（库里 250~260℃ 三行都是「工艺蒸汽」，而 steam_pp 只在「发电」分支评估）", "工程取值"],
    ["genEta", "发电机+机械效率（MW 级）", "1 台 1 kW 台架实测 + 工程常规值（MW 级 0.95~0.97）", "实测 + 工程常规值"],
    ["exhaustFloor", "气体载体排烟下限", "150℃；高硫煤/酸露点一侧 120、保守一侧 180 作扰动", "工程取值"],
    ["liquidFloor", "液体载体可用热下限", "40℃；25（有更冷水源）与 80（只有温水/回水）作扰动", "工程取值"],
    ["chillerClass", "电制冷基准机型", "常规离心机 4.82（重庆通用工厂试验）；高端磁浮 6.44 为**情景值**、依据待标定", "实测 + 情景值"],
    ["storageMode", "储热收益口径", "默认「售热（替代燃料）」；「峰谷套利（替代峰段电加热）」为替代口径", "工程口径"]
  ];

  function decisionCertificate(res, scene, lam, meta) {
    if (!res || res.out_of_scope || !res.top) return null;
    const saved = Object.assign({}, PRICES);
    const base = res.top;
    const probes = [];

    function probe(name, detail, mutate) {
      try {
        mutate();
        const r = runDecision(scene, lam, meta);
        const top = r.top || "(无候选)";
        probes.push({ name: name, detail: detail, top: top,
                      label: DISPLAY[top] || top, flipped: top !== base });
      } catch (e) {
        probes.push({ name: name, detail: detail, top: "(出错)", label: "(出错)",
                      flipped: false, error: String((e && e.message) || e) });
      } finally {
        Object.keys(saved).forEach(function (k) { PRICES[k] = saved[k]; });
      }
    }

    /* 2026-10-11（P-4a）：**场景侧**扰动。
       原版 probe() 只能改 PRICES —— 而评委在面板上拖的「年运行小时 / 换热端差」是**场景字段**，
       证书一条都没扰到。落盘探针实测：这两项的影响面（13/17、15/17）**大于**
       证书里多数已覆盖项（热价 11/17、发电效率 5/17）⇒ 原版"0 翻转"只覆盖了影响面小的一侧。 */
    const scene0 = Object.assign({}, scene);
    function probeScene(name, detail, mut) {
      Object.keys(saved).forEach(function (k) { PRICES[k] = saved[k]; });
      try {
        const sc = Object.assign({}, scene0, mut);
        const r = runDecision(sc, lam, meta);
        const top = r.top || "(无候选)";
        probes.push({ name: name, detail: detail, top: top,
                      label: DISPLAY[top] || top, flipped: top !== base });
      } catch (e) {
        probes.push({ name: name, detail: detail, top: "(出错)", label: "(出错)",
                      flipped: false, error: String((e && e.message) || e) });
      } finally {
        Object.keys(saved).forEach(function (k) { PRICES[k] = saved[k]; });
      }
    }

    const e0 = saved.elec, h0 = saved.heatPrice, hr0 = saved.heatingHours;
    const amb0 = saved.heatAuxKwhGj;
    probe("电价 −20%", "0.68 → " + (e0 * 0.8).toFixed(2) + " 元/kWh",
      function () { PRICES.elec = e0 * 0.8; });
    probe("电价 +20%", "0.68 → " + (e0 * 1.2).toFixed(2) + " 元/kWh",
      function () { PRICES.elec = e0 * 1.2; });
    probe("热价 −30%", "98 → " + (h0 * 0.7).toFixed(1) + " 元/GJ（接近工业蒸汽市场价下沿）",
      function () { PRICES.heatPrice = h0 * 0.7; });
    probe("热价 +30%", "98 → " + (h0 * 1.3).toFixed(1) + " 元/GJ",
      function () { PRICES.heatPrice = h0 * 1.3; });
    /* ⚠ 这两条改的是**供暖季等效上限**（PRICES.heatingHours），**不是**场景「年运行小时」。
       P-4d（2026-10-11）：原来两条都叫"年运行小时"，与场景字段**同名不同物** ⇒
       评委照界面复算会得到不同的数。改名，并在明细里写死作用域。 */
    probe("供暖季等效上限 −20%", "3 200 → " + Math.round(hr0 * 0.8) +
      " h；**只影响「供暖·热水」需求**（其余需求不读它）",
      function () { PRICES.heatingHours = Math.round(hr0 * 0.8); });
    probe("供暖季等效上限 +20%", "3 200 → " + Math.round(hr0 * 1.2) + " h；作用域同上",
      function () { PRICES.heatingHours = Math.round(hr0 * 1.2); });
    /* ---- P-4a（2026-10-11）：补上**面板上可拖、原证书一条都没扰**的三个量 ----
       依据：落盘探针 tools/probe_cert_coverage.js 实测的影响面（场景年运行小时 13/17、
       换热端差 15/17、ORC 降温程 3/17）。不补，证书的"0 翻转"就只覆盖影响面小的一侧。 */
    const hrScene = Number(scene0["年运行小时"]) || DEFAULT_RUN_HOURS;
    probeScene("年运行小时 −40%（限产/停机口径）",
      hrScene + " → " + Math.round(hrScene * 0.6) + " h",
      function () { return { "年运行小时": Math.round(hrScene * 0.6) }; });
    probeScene("年运行小时 +25%（满负荷口径）",
      hrScene + " → " + Math.round(hrScene * 1.25) + " h",
      function () { return { "年运行小时": Math.round(hrScene * 1.25) }; });
    const dT0 = Number(scene0["换热端差_degC"]) || 10;
    probeScene("换热端差取 5 K（强化换热）", dT0 + " → 5 K（换热面积↑、可用热↑）",
      function () { return { "换热端差_degC": 5 }; });
    probeScene("换热端差取 20 K（保守）", dT0 + " → 20 K（换热面积↓、可用热↓）",
      function () { return { "换热端差_degC": 20 }; });
    probe("ORC 设计降温程取 30 K", saved.orcCooldown + " → 30 K（可用热少、蒸发温度高）",
      function () { PRICES.orcCooldown = 30.0; });
    probe("ORC 设计降温程取 60 K", saved.orcCooldown + " → 60 K（可用热多、蒸发温度低）",
      function () { PRICES.orcCooldown = 60.0; });
    probe("发电效率取下沿", "膨胀机等熵效率 0.7897 → 0.72（R245fa 商用机队中位）",
      function () { PRICES.effScale = ETA_T_LOW / 0.7897; });
    probe("发电效率取上沿", "膨胀机等熵效率 0.7897 → 0.90（效率表扫描上界）",
      function () { PRICES.effScale = ETA_T_HIGH / 0.7897; });
    probe("投资 −25%", "全部路径投资同时下调（对应「价格水平偏旧」的乐观方向）",
      function () { PRICES.investScale = 0.75; });
    probe("投资 +25%", "全部路径投资同时上调",
      function () { PRICES.investScale = 1.25; });
    probe("输配电耗取上沿", "3.43 → 6 kWh/GJ（含热源风机的准入值）",
      function () { PRICES.heatAuxKwhGj = 6.0; });
    probe("输配电耗取 0", "3.43 → 0（检验「热会自己走到用户那里」这个旧假设）",
      function () { PRICES.heatAuxKwhGj = 0.0; });
    /* 电制冷基准机型的等级带宽（2026-09-29 第二批）：常规离心机实测 4.80
↔ 高端机**情景值** 6.44（高端端依据待标定，见 chiller_grid.js）。电制冷是"制冷类"路径的对手，
       因此这一项直接决定吸收式/压缩式的胜负，必须单列一条扰动。 */
probe("电制冷按高端机（情景 +34%）", "基准 COP 4.82 → 6.44（高端机情景值；依据待标定）",
      function () { PRICES.chillerClass = CHILLER_CLASS_HIGH / CHILLER_REF_COP; });
probe("电制冷按老旧机（−15%）", "基准 COP 4.82 → 4.10（污垢/低效机组方向）",
      function () { PRICES.chillerClass = 0.85; });
    /* ---- 三项“工程取值/边界”扰动（2026-10-09，第十五批）----
       为什么加：这些量以前是**硬编码**的，评委问“这个数怎么来的、错了会怎样”时
       只能靠嘴解释。改成参数后，证书能直接回答“它错了推荐会不会翻”。
       每一项的取值依据都写在对应函数的注释里，没有实测的一律标“工程取值”。 */
    probe("蒸汽轮机效率取下沿", "MW 级等效 η_t 0.617 → 0.55（区间下沿）",
      function () { PRICES.steamEtaCapScale = 0.55 / 0.617; });
    probe("蒸汽轮机效率取上沿", "MW 级等效 η_t 0.617 → 0.80（水泥窑设计相对内效率口径）",
      function () { PRICES.steamEtaCapScale = 0.80 / 0.617; });
    /* P-4b（2026-10-11）：参数是活的，但**在工况库这 19 行范围内无差别** ——
       库里 250~260℃ 三行（#1/#5/#9）全是「工艺蒸汽」需求，而 steam_pp 只在 stage1 的
       **「发电」分支**里评估（decision_core.js 1106 行）。不改明细，这条就是"看起来在测、其实测不动"。 */
    probe("蒸汽边界下移到 250℃",
      "候选区间 → 250~650℃（按实际工程做法反推）。⚠ 参数是活的，但**在工况库这 19 行内无差别**：" +
      "库里 250~260℃ 三行都是「工艺蒸汽」，而蒸汽朗肯只在「发电」分支评估",
      function () { PRICES.steamBoundC = 250.0; });
    probe("蒸汽边界上移到 350℃",
      "候选区间 → 350~650℃（更保守立场）。⚠ 同上：库范围内无差别（合成「发电·烟气 300℃」场景下 350℃ 会剔掉蒸汽朗肯）",
      function () { PRICES.steamBoundC = 350.0; });
    probe("MW 级发电机效率取上沿", "0.95 → 0.97（工程取值上沿，无实测）",
      function () { PRICES.genEtaScale = 0.97 / 0.95; });
    /* 排烟下限（C1 之后成为决策驱动项）：120 / 180 两档（2026-10-09，DSH 要求） */
    probe("排烟下限取 120℃", "气体载体发电类可用热下限 150 → 120℃（高硫煤/酸露点上限一侧）",
      function () { PRICES.steamExhaustFloorC = 120.0; });
    probe("排烟下限取 180℃", "气体载体发电类可用热下限 150 → 180℃（偏保守一侧）",
      function () { PRICES.steamExhaustFloorC = 180.0; });
    /* 液体侧下限（B1，2026-10-10）：80℃ 与 25℃ 两档 */
    probe("液体下限取 25℃", "液体载体发电类可用热下限 40 → 25℃（假设有更冷的水源）",
      function () { PRICES.liquidFloorC = 25.0; });
    probe("液体下限取 80℃", "液体载体发电类可用热下限 40 → 80℃（只有温水/回水可用，偏保守）",
      function () { PRICES.liquidFloorC = 80.0; });
    if (res.keys && (res.keys.indexOf("pcm_storage") >= 0 || res.keys.indexOf("tc_storage") >= 0)) {
      probe("储热改为峰谷套利口径", "售热 → 峰谷套利（替代峰段电加热）",
        function () { PRICES.storageMode = "arbitrage"; });
    }

    const flips = probes.filter(function (p) { return p.flipped; });
    return {
      top: base, topLabel: DISPLAY[base], closeness: res.order[0].closeness,
      candidates: res.keys.map(function (k) { return DISPLAY[k]; }),
      probes: probes, flips: flips.length, total: probes.length,
      assumptions: CERT_ASSUMPTIONS.map(function (row) {
        const rawH = Number(scene0["年运行小时"]);
        const usedH = (res.scene && res.scene["年运行小时"] !== undefined)
          ? Number(res.scene["年运行小时"]) : rawH;
        const V = {
          elec: saved.elec,
          heatPrice: saved.heatPrice,
          /* P-4d（2026-10-11）：这一行显示**场景实际用的小时数**（可能已被上限折算），
             **不是**上限本身。原版显示 PRICES.heatingHours（3200），与场景面板同名不同物 ⇒
             评委照界面复算会得到不同的数。 */
          hours: (usedH !== rawH)
            ? (usedH + " h（表值 " + rawH + " h，已按供暖季等效上限 " + heatingHoursCap() + " h 折算）")
            : (usedH + " h"),
          heatHoursCap: heatingHoursCap() + " h",
          heatAux: saved.heatAuxKwhGj + " kWh/GJ",
          deltaT: ((Number(scene0["换热端差_degC"]) || 10) + " K"),
          orcCooldown: saved.orcCooldown + " K",
          orcEff: null, capex: null,
          steamEta: "MW 级 η_t = " + STEAM_ETA_REF + "；<30 MW 取区间 55%~80%（×" +
            (0.55 / STEAM_ETA_REF).toFixed(3) + " / ×" + (0.80 / STEAM_ETA_REF).toFixed(3) + "）",
          steamBound: saved.steamBoundC + "℃",
          genEta: "MW 级 0.95（扰动取上沿 0.97）；当前缩放 " + saved.genEtaScale,
          exhaustFloor: saved.steamExhaustFloorC + "℃",
          liquidFloor: saved.liquidFloorC + "℃",
          chillerClass: saved.chillerClass + " × 常规离心机 " + CHILLER_REF_COP +
            " ⇒ 等效 COP " + (CHILLER_REF_COP * saved.chillerClass).toFixed(2),
          storageMode: saved.storageMode
        };
        return { key: row[0], name: row[1], value: V[row[0]], source: row[2], grade: row[3] };
      }),
      statement: flips.length === 0
        ? ("在上述 " + probes.length + " 项假设扰动下，推荐结论**没有变化**"
           + "（" + DISPLAY[base] + " 始终居首）")
        : ("在上述 " + probes.length + " 项假设扰动下，有 " + flips.length +
           " 项会让推荐改变：" + flips.map(function (p) { return p.name + "→" + p.label; }).join("、"))
    };
  }

  /* ---- ORC 设计点扫描与"功率最优设计点"（2026-09-28，P2-9）----
     为什么需要：设计降温程（源侧被冷却多少 K）决定了两件相反的事——
     降温越大，可回收的热越多（分子大），但蒸发温度被压低、循环效率下降（比例小）。
     真实项目取 45~65 K（可用实测锚点 45、48 K），说明工程上并没有"越大越好"。

     本函数在给定热源条件下，逐 1 K 扫过可行的蒸发温度，算净电功率 =
     净效率(蒸发温度) × 可回收热(蒸发温度)，给出净功率最大的设计点供对照。

     ⚠ 它只优化功率，**没有计入换热器面积/压降/场地成本**（降温越大，换热器越贵），
     所以它给出的都是"可行域边界附近"的设计，不能直接当推荐设计用 —— 界面照此说明。 */
  function orcDesignScan(tSrc, mDot, medium, dT) {
    const tS = Number(tSrc), dt = Number(dT);
    const tEvapMax = Math.min(tS - dt - 5.0, 350.0);
    const rows = [];
    if (!(tEvapMax > 60.0) || !(Number(mDot) > 0) || !CP[medium]) return rows;
    for (let te = 60.0; te <= tEvapMax + 1e-9; te += 1.0) {
      const q = Number(mDot) * CP[medium] * Math.max(tS - te - dt, 5.0);
      if (!(q > 0)) continue;
      const eff = orcNetEffByEvap(te, q);
      if (eff === null || eff === undefined) continue;
      rows.push({ tEvapC: te, cooldownK: tS - te, qKw: q, effPct: eff,
                  sourceDropK: tS - te - dt, netKw: q * eff / 100.0 });
    }
    return rows;
  }

  /* 返回 { current, best, gainPct }：当前设计（按界面降温程）与功率最优设计点 */
  function orcOptimalDesign(tSrc, mDot, medium, dT) {
    const rows = orcDesignScan(tSrc, mDot, medium, dT);
    if (!rows.length) return null;
    let best = rows[0];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].netKw > best.netKw) best = rows[i];
    }
    const tS = Number(tSrc), dt = Number(dT);
    const teCur = orcDesignEvapTemp(tS, dt);
    const qCur = Number(mDot) * CP[medium] * Math.max(tS - teCur - dt, 5.0);
    const effCur = orcNetEffByEvap(teCur, qCur);
    const current = { tEvapC: teCur, cooldownK: tS - teCur,
                      sourceDropK: Math.max(tS - teCur - dt, 5.0), qKw: qCur,
                      effPct: effCur, netKw: (effCur === null ? null : qCur * effCur / 100.0) };
    const gainPct = (current.netKw && best.netKw)
      ? (best.netKw / current.netKw - 1.0) * 100.0 : null;
    return { current: current, best: best, gainPct: gainPct, n: rows.length };
  }

  function orcDetail(tSrc, mDot, medium, hours, dT) {
    /* 查表温度 2026-09-28 与 orcEffPct 统一为**设计蒸发温度**（热源−50 K）。
       以前这里用 热源−端差，和矩阵里的 orcEffPct 不是同一个温度，属遗留不一致。 */
    const scene = { "需求": "发电", "热源温度_degC": tSrc, "载体": medium,
      "流量_kg_s": mDot, "换热端差_degC": dT, "年运行小时": hours,
      "连续性": "连续", "驱动来源": "余热自驱动", "需求温度_degC": null };
    const q = orcRecoveredKw(scene);
    const d = orcEfficiencyForScene(scene, q);
    if (!d) return null;
    const c = d.tEvapC === null ? null : d.tEvapC;
    const row = pctLookupRow(TABLES.orcPct, c);
    /* 单位口径（2026-09-28 修）：p50 / p50Table 一律用"kW 净输出 / MW 回收热"，
       parasitic 用"百分点"（= 表值% − 交付%）。此前 p50 换成 %、p50Table 仍是 kW/MW，
       界面把 84 与 8.2 相减显示成"寄生损失 75.8 个百分点"。 */
    const p50 = d.effPct * 10.0;
    /* ⚠ 2026-10-09（DSH 复核 ③：界面可见的口径错）：
       只有 `design === "single"` 时，`p50`（来自一维单压表经规模/寄生修正）与
       `p50Table`（一维表原始值）才是**同一个模型的修正前后**，此时"表值 − 寄生 = 交付"才成立。
       非 single 设计下 p50 来自**两级表或二维表**（不同模型！），相减会出现
       **负的寄生损失**——实测 118℃(two-stage) → −5.23、200℃(cond-aware) → −4.37，
       而界面 ui.js 会逐字显示"表值 97.9 − 系统寄生损失 −4.37 个百分点 = 交付 14.16%"。
       处置：① 非 single 时 p50Table/parasitic **置 null**（界面显示"—"）；
             ② 任何情况下 parasitic 不得为负。 */
    const isSingle = (d.design === "single");
    const p50TableRaw = row ? row[2] : null;
    const p50Table = isSingle ? (p50TableRaw === null ? p50 : p50TableRaw) : null;
    const parasitic = (isSingle && p50Table !== null)
      ? Math.max(0, (p50Table - p50) / 10.0) : null;
    const net = p50 * q / 1000;
    const mwh = net * hours / 1000;
    return { q, p10: row ? row[1] : null, p50, p90: row ? row[3] : null,
             n: row ? row[4] : null, net, mwh,
             p50Table: p50Table, parasitic: parasitic,
             p50TableIsSingle: isSingle,
             effPct: d.effPct, design: d.design,
             designNote: d.note, spanK: d.spanK, tCondC: d.tCondC,
             co2: mwh * GRID_EF, money: mwh * 1000 * elecPrice() / 10000 };
  }

  function steamDetail(tSrc, mDot, medium, hours, dT) {
    const tb = clamp(tSrc - 100.0, 180.0, 540.0);
    const row = TABLES.stPct ? pctLookupRow(TABLES.stPct, tb) : null;
    const q = steamRecoveredKw({ "热源温度_degC": tSrc, "载体": medium, "流量_kg_s": mDot, "换热端差_degC": dT });
    const p50Table = steamEffPct(tSrc) * 10.0;
    /* 2026-10-09：细账拆成三段，界面才能分别报「容量修正」和「寄生损失」：
         表值 → ×蒸汽轮机容量系数（η_t/0.7891） → 扣泵功与管路压降 = 交付净效率 */
    const cap0 = Math.max(q * p50Table / 1000.0, 1e-6);   // kW：q[kW] × 效率[kW/MW热]/1000
    const etaInfo = steamEtaTByCap(cap0);
    const p50Cap = p50Table * (etaInfo.mid / STEAM_ETA_REF);
    /* ⚠ 2026-10-13（P0-1 配套）：细账由**两段**改**三段** ——
       表值 → ×容量系数 → **×发电机+机械效率** → 扣寄生 = 交付。
       改后"三段之和 = 总损失"恒成立，界面上能分别看到每层扣了多少。 */
    const genEtaVal = generatorEta(cap0);
    const p50Gen = p50Cap * genEtaVal;
    const netPct = netEffPct("steam_pp", tSrc, q, dT);
    const p50 = (netPct === null || netPct === undefined) ? p50Cap : netPct * 10.0;
    const net = p50 * q / 1000;
    const mwh = net * hours / 1000;
    return { q, p10: row ? row[1] : null, p50, p90: row ? row[3] : null,
             n: row ? row[4] : null, net, mwh, p50Table,
             /* ⚠ 2026-10-09（DSH 复核 P6f）：这两个字段的口径是**百分点**，
                与 orcDetail 的 parasitic 对齐（orcDetail 里除了 10）。旧版漏除，
                量级差 10 倍（潜伏：界面当时还没渲染这个字段）。 */
             etaCorr: (p50Table - p50Cap) / 10.0,
            genEta: genEtaVal,
            genCorr: (p50Cap - p50Gen) / 10.0,
            parasitic: (p50Gen - p50) / 10.0,
             etaT: etaInfo.mid, etaInData: etaInfo.inData,
             etaNote: etaInfo.note,
             co2: mwh * GRID_EF, money: mwh * 1000 * elecPrice() / 10000 };
  }

  function heatDetail(mDot, medium, tSrc, hours, dT, cop) {
    const dt = Math.max(tSrc - 40 - dT, 5);
    const q = mDot * CP[medium] * dt;
    const heatGj = q * hours * 3.6 / 1000;
    const replaced = heatGj * GAS_EF / BOILER_EFF;
    if (cop) {
      const mwhE = heatGj / 3.6 / cop;
      const co2E = mwhE * GRID_EF;
      return { q, heatGj, co2: Math.max(replaced - co2E, 0), money: (heatGj * heatPrice() - mwhE * 1000 * elecPrice()) / 10000 };
    }
    return { q, heatGj, co2: replaced, money: heatGj * heatPrice() / 10000 };
  }

  return {
    PATH_KEYS, DISPLAY, INDICATORS, DIRECTIONS, CP, BASE_INDICATORS,
    ABS_COOL_T_MIN, COP_C_ABS, COP_E_COOL, GRID_EF, ELEC_PRICE, HP_COP,
    COP_I_ABS_SELF, COP_II_ABS_SELF, COP_H_ABS_EXT,
    setPrices, elecPrice, heatingHoursCap, heatPrice, HEATING_SEASON_HOURS, DEFAULT_RUN_HOURS, GAS_PRICE,
    valleyElec, peakValley, storageRevenueMode, storageChargeMode, storageHoursOf,
    storageReduction, ELEC_HEAT_ETA, NO_PAYBACK_YEARS,
    HP_ETA_CARNOT, HP_APPROACH_K, compCopFor, compSupplyTemp,
    hpCopEnvelope, HP_COP_ENVELOPE, absIICop, ABS_II_DRIVE,
    setTables, validateScene, recoveredHeatKw, scaleBand, scaleMultiplier,
    absCoolCop, stage1, buildMatrixV2, entropyWeights, combinedWeights,
    topsis, runDecision, boundaryNotices, orcEffPct, steamEffPct,
    netEffPct, parasiticPct,
    orcEffByEvapTemp, orcNetEffByEvap, orcDesignScan, orcOptimalDesign, orcCooldownK,
    orcDesignEvapTemp, turbineEtaOf, turbineSizeFactor, ETA_T_REF,
    orcEfficiencyForScene, twoStageEffPct, orcTwoStageApplicable,
    ambientC, ORC2_MIN_SPAN, ORC2_MAX_TIN, orcTwoStageUsable, ORC2_MAX_TIN_LIQUID,
    heatTransportKwhGj, heatTransportKwh, heatTransportCo2, hpSizeFactor,
    orcEffRange, ETA_T_LOW, ETA_T_HIGH,
    orcCondP50, orcCondUsable,
    electricChillerCop, chillerCop, CHILLER_ETA_CARNOT, chillerCopFromGrid,
    chillerEvapShapeFactor, electricChillerCopBand,
    CHILLER_REF_COP, CHILLER_REF_T_COND, CHILLER_COND_SENS,
    CHILLER_CLASS_LOW, CHILLER_CLASS_HIGH, CHILLER_APPROACH_K, CHILLER_EVAP_C,
    directEffRange, isGasGasDirect, DIRECT_EFF_PCT, DIRECT_EFF_GAS_GAS_LOW_LOAD,
    generatorEta, GEN_ETA_CURVE, steamEffRangePct, CHILLER_PART_LOAD,
    steamEtaTByCap, steamEtaFactor, STEAM_ETA_REF,
    expanderMapEta,
    tegEffPct, TEG_CURVE, transportKwhGjFor, dryingTransportKwhGj, DRYING_ELEC_SHARE,
    decisionCertificate, CERT_ASSUMPTIONS,
    orcDetail, steamDetail, heatDetail, pctLookupRow
    , orcRecoveredKw, steamRecoveredKw, qForPath, orcEvapTemp
    , orcFeasible, ORC_PINCH_MIN_K, orcCondLookup, orcCondBounds
    , cpOf, isGasCarrier, steamExhaustFloorC, tegRecoveredKw, liquidFloorC
    , ORC_COOLDOWN_K, STEAM_EXHAUST_FLOOR_C, HEAT_MIN_COOLDOWN_K, heatFloor
  };
})();
