const API_URL = 'https://ab-nexus-api.amitbhavikmnm.workers.dev';
async function login(email, password) {
try {
const response = await fetch(`${API_URL}/api/auth/login`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ email, password })
});
const data = await response.json();
if (data.success) {
localStorage.setItem('token', data.token);
localStorage.setItem('user', JSON.stringify(data.user));
return { success: true };
} else {
return { success: false, error: data.error };
}
} catch (error) {
return { success: false, error: error.message };
}
}
function logout() {
localStorage.removeItem('token');
localStorage.removeItem('user');

window.location.href = 'index.html';
}
function getUser() {
const user = localStorage.getItem('user');
return user ? JSON.parse(user) : null;
}