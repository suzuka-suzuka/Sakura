/**
 * 将 master 配置标准化为数组，统一使用 String 比较
 * @param {number|string|Array} master
 * @returns {string[]}
 */
export function normalizeMasters(master) {
  if (!master && master !== 0) return [];
  const arr = Array.isArray(master) ? master : [master];
  return arr.map(String);
}

/**
 * 判断 userId 是否为 master
 * @param {number|string} userId
 * @param {number|string|Array} master
 * @returns {boolean}
 */
export function isMasterUser(userId, master) {
  return normalizeMasters(master).includes(String(userId));
}

export default {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  normalizeMasters,
  isMasterUser,
};
