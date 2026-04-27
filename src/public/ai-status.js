
import { fetchAiApiStatus } from './ai-status-data.js';

async function renderAiStatusTable() {
  const aiApis = await fetchAiApiStatus();
  const table = document.createElement('table');
  table.className = 'ai-status-table';
  table.innerHTML = `
    <thead><tr><th>AI API</th><th>Status</th><th>Remaining Credits</th></tr></thead>
    <tbody>
      ${aiApis.map(api => `<tr><td>${api.name}</td><td>${api.status}</td><td>${api.remaining}</td></tr>`).join('')}
    </tbody>
  `;
  return table;
}

export async function mountAiStatusTable() {
  let container = document.getElementById('ai-status-table-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'ai-status-table-container';
    container.style.margin = '16px 0';
    const topbar = document.querySelector('.topbar');
    topbar.parentNode.insertBefore(container, topbar.nextSibling);
  }
  container.innerHTML = '';
  container.appendChild(await renderAiStatusTable());
}

document.addEventListener('DOMContentLoaded', mountAiStatusTable);
