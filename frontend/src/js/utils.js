const API_URL = 'https://ab-nexus-api.amitbhavikmnm.workers.dev';

async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const response = await fetch(`${API_URL}${endpoint}`, { ...options, headers });
    if (response.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = 'index.html';
      throw new Error('Session expired');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  } catch (err) {
    if (err.message !== 'Session expired') console.error('API Error:', err);
    throw err;
  }
}

async function uploadFile(file, entityType, entityId) {
  const token = localStorage.getItem('token');
  const formData = new FormData();
  formData.append('file', file);
  formData.append('entityType', entityType);
  formData.append('entityId', entityId);
  const response = await fetch(`${API_URL}/api/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });
  return response.json();
}

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open');
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'index.html';
}

function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:10px;
    color:white;font-size:14px;font-weight:500;z-index:9999;
    background:${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#8b5cf6'};
    box-shadow:0 4px 12px rgba(0,0,0,0.3);animation:slideIn 0.3s ease;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatCurrency(amount) {
  if (!amount) return '₹0';
  return '₹' + Number(amount).toLocaleString('en-IN');
}

function requireAuth() {
  const token = localStorage.getItem('token');
  if (!token) { window.location.href = 'index.html'; return false; }
  return true;
}