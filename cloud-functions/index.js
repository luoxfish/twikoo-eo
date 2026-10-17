// Current EdgeOne runtime entry; keep node-functions for existing deployments.
import handleRequest from '../node-functions/index.js'

export const onRequest = (context) => {
  return handleRequest(context)
}
