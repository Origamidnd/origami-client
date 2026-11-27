import dayjs from 'dayjs'

// The message may quote a URL or a reason: the core escapes those quotes, so they do not end it.
const LOGRUS = /time="(.+?)"\s+level=(.+?)\s+msg="((?:[^"\\]|\\.)+)"/
const PLAIN = /(.+?)\s+(.+?)\s+(.+)/

/** One core log line as the service hands it over: logrus style or "time level text". */
export const parseCoreLogLine = (log: string): ILogItem | null => {
  const result = log.match(LOGRUS)
  if (result) {
    const [, time, type, payload] = result
    return {
      time: dayjs(time).format('MM-DD HH:mm:ss'),
      type,
      payload: payload.replace(/\\(["\\])/g, '$1'),
    }
  }
  const plain = log.match(PLAIN)
  if (plain) {
    const [, time, type, payload] = plain
    return { time, type, payload }
  }
  return null
}
