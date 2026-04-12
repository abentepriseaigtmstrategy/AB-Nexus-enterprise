// Surveyor specific functions
async function loadClaims() {
const data = await apiRequest('/api/claims');
return data.claims;
}
async function loadClaimStats() {
const data = await apiRequest('/api/dashboard/stats?platform=surveyor');
return data.stats;
}