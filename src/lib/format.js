export function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatSpeed(speedMBps) {
  if (!speedMBps || speedMBps <= 0.05) return '0 MB/s';
  if (speedMBps < 1) {
    return `${(speedMBps * 1024).toFixed(1)} KB/s`;
  }
  return `${speedMBps.toFixed(1)} MB/s`;
}
