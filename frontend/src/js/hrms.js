// HRMS specific functions
async function loadEmployees() {
const data = await apiRequest('/api/employees');
return data.employees;
}
async function loadLeaveRequests() {
const data = await apiRequest('/api/leave-requests');
return data.leaves;
}