/* 膨胀机效率-规模关系 —— 由 tools/turbine_size_fit.py 生成，勿手改。
   数据：Landelle 实验 ORC 数据库（真实机组实测 η_t 与发电功率）。
   用途：给代理模型补上'规模'这一维（小机组膨胀机效率更低）。
*/
window.WHTURBINE_SIZE = { "meta": { "source": "Landelle Experimental ORC database（Zenodo 10.5281/zenodo.400556, CC BY 4.0）—项目内 38 台机组子集", "n": 38, "note": "分档中位为实测；>100 kW 无实验数据，按 100 kW 档保持（不外推）", "referenceEtaT": 0.7897, "rule": "只做保守修正：correction = min(1, η_t(size)/0.80)（不给大机组加成）", "fit": { "intercept": 0.7201, "slope": 0.0374 } }, "bands": [ [ 0.1, 1, 0.7, 12 ], [ 1, 5, 0.7645, 18 ], [ 5, 20, 0.71, 5 ], [ 20, 100, 0.685, 3 ] ] };
