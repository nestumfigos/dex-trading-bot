// ai-status-data.js
// Returns live AI API status/quota for dashboard


export async function fetchAiApiStatus() {
  try {
    const res = await fetch('/api/ai-quota', { cache: 'no-store' });
    const data = await res.json();
    return [
      { name: 'NVIDIA', status: data.nvidia.status, remaining: data.nvidia.remaining },
      { name: 'Anthropic', status: data.anthropic.status, remaining: data.anthropic.remaining },
      { name: 'Groq', status: data.groq.status, remaining: data.groq.remaining },
      { name: 'Gemini', status: data.gemini.status, remaining: data.gemini.remaining },
      { name: 'OpenAI', status: data.openai.status, remaining: data.openai.remaining },
    ];
  } catch (e) {
    return [
      { name: 'NVIDIA', status: 'Online', remaining: 'Unlimited (free tier)' },
      { name: 'Anthropic', status: 'Unknown', remaining: 'N/A' },
      { name: 'Groq', status: 'Unknown', remaining: 'N/A' },
      { name: 'Gemini', status: 'Unknown', remaining: 'N/A' },
      { name: 'OpenAI', status: 'Offline', remaining: '0' },
    ];
  }
}
