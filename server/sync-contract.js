'use strict';

/**
 * 「以后两端要互通」的契约 —— 现在只定义，不实现同步。
 * ---------------------------------------------------------------
 * 当前状态：桌面端和手机端是两个完全独立的实例，各用各的 WB_DATA_DIR，
 * 不写任何同步逻辑，也绝不去读对方的数据。
 *
 * 这个文件的意义是：将来真要接同步时，不用回头改数据模型。
 * 它把「哪些字段是同步需要的」和「冲突怎么裁决」先定下来，
 * 任何同步实现只要遵守这份契约就能接上。
 *
 * 现在会被用到的只有 describe() 和 envelope()：
 *   · GET /api/sync/contract  告诉界面/将来的同步端「我现在支持到哪一步」
 *   · JSON 导出               带上实例身份和版本号，人工搬运也不丢来源
 */

const SCHEMA_VERSION = 3;
/** 当前明确不互通。界面和文档都读这个值，不靠口头约定。 */
const SYNC_ENABLED = false;

/** 将来允许接的冲突策略。默认 manual：不悄悄覆盖任何一端的数据。 */
const MERGE_STRATEGIES = ['manual', 'last-write-wins'];
const DEFAULT_MERGE_STRATEGY = 'manual';

/**
 * 一条记录将来同步时要带的最小元数据。
 * 现在**不写进业务数据**，只在契约里声明形状，避免给现有 74MB 数据做一次无谓的迁移。
 * 真开始同步时，由 db.put 统一补这三个字段即可。
 */
function syncFields(originId, at = new Date().toISOString()) {
  return {
    originId,          // 最早产生这条记录的是哪个实例
    updatedAt: at,     // 增量同步的游标
    rev: 1,            // 同一条记录的版本号，冲突检测用
    deletedAt: null,   // 墓碑：软删除现在已有 .trash/，将来升级成记录级标记
  };
}

/** 只读契约：界面与将来的同步端都从这里判断能力 */
function describe(instanceId) {
  return {
    enabled: SYNC_ENABLED,
    schemaVersion: SCHEMA_VERSION,
    instanceId,
    platform: process.env.WB_PLATFORM || 'local',
    dataDir: process.env.WB_DATA_DIR || '(项目内 data/)',
    /** 现在两端各存各的，互不访问；下面这些是接同步时要补的三块 */
    capabilities: {
      independentDataDirs: true,
      exportEnvelope: true,
      softDelete: true,
      recordLevelSyncFields: false,
      incrementalCursor: false,
      conflictResolution: false,
      remoteSyncService: false,
    },
    planned: {
      recordFields: Object.keys(syncFields('example')),
      mergeStrategies: MERGE_STRATEGIES,
      defaultMergeStrategy: DEFAULT_MERGE_STRATEGY,
      missing: [
        '记录级 originId / updatedAt / rev / deletedAt',
        '按 updatedAt 的增量拉取游标',
        '冲突检测与人工选择界面',
        '一个两端都能访问的同步服务（或端对端直连）',
      ],
    },
    note: '两个实例当前完全独立。JSON 导出可以人工搬运，自动同步尚未实现。',
  };
}

/** 导出信封：原有字段一个不少，只在外层加一份 sync 元信息 */
function envelope({ instanceId, collections, exportedAt = new Date().toISOString() }) {
  return {
    sync: {
      schemaVersion: SCHEMA_VERSION,
      enabled: SYNC_ENABLED,
      instanceId,
      exportedAt,
      /** 将来做增量同步时，这个时间戳就是第一次拉取的起点 */
      cursor: exportedAt,
      mergeStrategy: DEFAULT_MERGE_STRATEGY,
    },
    ...collections,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SYNC_ENABLED,
  MERGE_STRATEGIES,
  DEFAULT_MERGE_STRATEGY,
  syncFields,
  describe,
  envelope,
};
