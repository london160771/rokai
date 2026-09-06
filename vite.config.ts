import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { geminiPolicyApi } from './server/geminiPolicyApi.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), geminiPolicyApi({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL })],
  }
})
