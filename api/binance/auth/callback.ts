import { handleVercelBinanceApi } from '../../../server/vercelBinanceApi.js'

export function fetch(request: Request): Promise<Response> {
  return handleVercelBinanceApi('auth-callback', request)
}
