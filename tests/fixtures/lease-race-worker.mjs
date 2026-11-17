import { createWorkspaceLeaseManager } from '../../lib/util/workspace-lease.js'
let lease
const manager = createWorkspaceLeaseManager({ ownerDirectory: process.argv[3] })
process.on('message', async message => {
  try {
    if (message.action === 'claim') {
      lease = await manager.acquire(process.argv[2], process.argv[4], 'write', undefined, { wait: false })
      process.send({ id: message.id, granted: true, leaseId: lease.leaseId })
    } else if (message.action === 'release') {
      await Promise.all([lease.release({ confirmedStopped: true }), lease.release({ confirmedStopped: true })])
      process.send({ id: message.id, released: true })
    } else if (message.action === 'exit') process.exit(0)
  } catch (error) { process.send({ id: message.id, granted: false, code: error.code }) }
})
