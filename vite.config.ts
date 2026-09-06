import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { geminiPolicyApi } from './server/geminiPolicyApi'
import { binanceAgentOsApi } from './server/binanceAgentOsApi'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      geminiPolicyApi({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }),
      binanceAgentOsApi({
        mcpUrl: env.BINANCE_AGENT_OS_MCP_URL,
        publicUrl: env.ROKAI_PUBLIC_URL,
        clientMetadataUrl: env.BINANCE_OAUTH_CLIENT_METADATA_URL,
        redirectUrl: env.BINANCE_OAUTH_REDIRECT_URL,
      }),
    ],
  }
})
