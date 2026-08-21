import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@dsh-external/deepseek-balance-monitor', ['src/index.ts', 'src/typert.host.ts'], {
  portableCssModuleIds: true,
})
