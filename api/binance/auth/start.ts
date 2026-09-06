import { handleVercelBinanceApi } from '../../../server/vercelBinanceApi'

export default function handler(request: Request): Promise<Response> {
  return handleVercelBinanceApi('auth-start', request)
}
