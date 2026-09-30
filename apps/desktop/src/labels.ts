/** 中文文案表（不再使用 i18n） */

export const ROOM_LABELS: Record<string, string> = {
  all: '全部',
  living: '客厅',
  bedroom: '卧室',
  kitchen: '厨房',
  balcony: '阳台',
  unassigned: '未分配房间',
}

export const CATEGORY_LABELS: Record<string, string> = {
  speaker: '音箱',
  light: '灯具',
  plug: '插座',
  sensor: '传感器',
  scale: '体脂秤',
  'ab-wheel': '健腹轮',
  fridge: '冰箱',
  ac: '空调',
  massager: '按摩仪',
  dehumidifier: '除湿机',
  'air-purifier': '空气净化器',
  camera: '摄像机',
  vacuum: '扫地机',
  lock: '门锁',
  other: '其他',
}

export const NAV_LABELS: Record<string, string> = {
  'nav.home': '首页',
  'nav.devices': '设备',
  'nav.scenes': '场景',
  'nav.automation': '自动化',
  'nav.templates': '插件',
  'nav.store': '商城',
  'nav.profile': '我的',
}

export const AC_MODE_LABELS: Record<string, string> = {
  auto: '自动',
  cool: '制冷',
  dry: '除湿',
  heat: '制热',
  fan: '通风',
}

export const MASSAGER_MODE_LABELS: Record<string, string> = {
  vitality: '活力模式',
  knead: '轻揉模式',
  unpack: '解压模式',
}

export const MASSAGER_STATE_LABELS: Record<string, string> = {
  vitality: '活力模式',
  knead: '轻揉模式',
  unpack: '解压模式',
  scene: '场景模式',
  standby: '待机',
  charge: '充电中',
  shutdown: '已关机',
  unknown: '未知状态',
}

export const MASSAGER_SPEED_LABELS: Record<string, string> = {
  off: '关',
  slow: '慢',
  fast: '快',
}

export const PURIFIER_MODE_LABELS: Record<string, string> = {
  auto: '自动',
  sleep: '睡眠',
  manual: '手动',
}

export const PLUG_PERIOD_LABELS: Record<string, string> = {
  week: '周',
  month: '月',
  year: '年',
}

/** 旧版 i18n key → 中文（本地缓存可能仍存英文 key） */
export const AUTOMATION_LABELS: Record<string, string> = {
  'automation.rules.motionLight': '检测到有人 → 打开客厅灯',
  'automation.rules.hotAc': '温度过高 → 打开空调',
  'automation.rules.nightOff': '晚上 22:00 → 关闭全部灯光',
  'automation.rules.doorCam': '门锁打开 → 摄像机开始录像',
  motionLight: '检测到有人 → 打开客厅灯',
  hotAc: '温度过高 → 打开空调',
  nightOff: '晚上 22:00 → 关闭全部灯光',
  doorCam: '门锁打开 → 摄像机开始录像',
}

export const LOGIN_FEATURE_LABELS: Record<string, string> = {
  home: '智能家居',
  security: '安全守护',
  energy: '绿色节能',
  life: '品质生活',
}

export const PCBOOT_STATUS_LABELS: Record<string, string> = {
  poweredOn: '已开机',
  poweredOff: '已关机',
  booting: '正在开机',
  shuttingDown: '正在关机',
  rebooting: '正在重启',
  forceRebooting: '正在强制重启',
  bootFailed: '开机失败',
  shutdownFailed: '关机失败',
  busy: '正在执行',
  forceShuttingDown: '正在强制关机',
}

export const PCBOOT_LOG_LABELS: Record<string, string> = {
  powerOn: '开机',
  powerOff: '关机',
  indicatorOn: '打开指示灯',
  indicatorOff: '关闭指示灯',
  childLockOn: '开启童锁',
  childLockOff: '关闭童锁',
  restart: '重启电脑',
  forceOff: '强制关机',
  timerOn: '定时开机',
  timerOff: '定时关机',
  countdownOn: '倒计时开机',
  countdownOff: '倒计时关机',
  remoteOn: '远程开机',
  remoteOff: '远程关机',
  remoteReboot: '远程重启',
  localOn: '本地开机',
  localOff: '本地关机',
  localReboot: '本地重启',
}

export function pickLabel(
  map: Record<string, string>,
  key: string | undefined | null,
  fallback?: string,
): string {
  if (!key) return fallback || ''
  return map[key] || fallback || key
}
