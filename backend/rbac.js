// backend/rbac.js — McLarens Nexus Enterprise v5.0
// Role-Based Access Control with complete permission mappings

// Role definitions 
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  SURVEYOR: 'surveyor',
  INSURER: 'insurer',
  HR_MANAGER: 'hr_manager',
  FINANCE: 'finance',
  VIEWER: 'viewer'
};

// Complete permission mapping
export const PERMISSIONS = {
  // Admin permission (for general admin access check)
  'admin': ['super_admin', 'admin'],
  
  // Insurance Company Permissions
  insurer_created: ['super_admin', 'admin'],
  insurer_create: ['super_admin', 'admin'],
  view_insurers: ['super_admin', 'admin', 'surveyor', 'insurer', 'viewer', 'hr_manager', 'finance'],
  update_insurer: ['super_admin', 'admin'],
  delete_insurer: ['super_admin', 'admin'],
  manage_insurer_rules: ['super_admin', 'admin'],
  view_insurer_rules: ['super_admin', 'admin', 'surveyor', 'insurer'],
  
  // Claim Permissions
  create_claim: ['super_admin', 'admin', 'surveyor'],
  view_claim: ['super_admin', 'admin', 'surveyor', 'insurer', 'viewer'],
  update_claim: ['super_admin', 'admin', 'surveyor'],
  delete_claim: ['super_admin', 'admin'],
  settle_claim: ['super_admin', 'admin', 'surveyor', 'finance'],
  view_all_claims: ['super_admin', 'admin'],
  
  // Document Permissions
  upload_document: ['super_admin', 'admin', 'surveyor'],
  view_document: ['super_admin', 'admin', 'surveyor', 'insurer'],
  delete_document: ['super_admin', 'admin'],
  verify_document: ['super_admin', 'admin', 'surveyor'],
  
  // Pending Documents Permissions
  view_pending_docs: ['super_admin', 'admin', 'surveyor', 'insurer'],
  update_pending_docs: ['super_admin', 'admin', 'surveyor'],
  send_doc_reminders: ['super_admin', 'admin', 'surveyor'],
  
  // AI Permissions
  use_ai_verification: ['super_admin', 'admin', 'surveyor'],
  confirm_ai_action: ['super_admin', 'admin', 'surveyor'],
  view_ai_audit: ['super_admin', 'admin', 'surveyor'],
  
  // Survey Report Permissions
  create_survey_report: ['super_admin', 'admin', 'surveyor'],
  view_survey_report: ['super_admin', 'admin', 'surveyor', 'insurer'],
  update_survey_report: ['super_admin', 'admin', 'surveyor'],
  approve_survey_report: ['super_admin', 'admin'],
  
  // HRMS Permissions
  manage_employees: ['super_admin', 'admin', 'hr_manager'],
  view_employees: ['super_admin', 'admin', 'hr_manager', 'finance'],
  create_employee: ['super_admin', 'admin', 'hr_manager'],
  update_employee: ['super_admin', 'admin', 'hr_manager'],
  delete_employee: ['super_admin', 'admin', 'hr_manager'],
  
  manage_attendance: ['super_admin', 'admin', 'hr_manager', 'surveyor'],
  view_attendance: ['super_admin', 'admin', 'hr_manager', 'finance', 'surveyor'],
  
  manage_leave: ['super_admin', 'admin', 'hr_manager'],
  view_leave: ['super_admin', 'admin', 'hr_manager', 'surveyor'],
  approve_leave: ['super_admin', 'admin', 'hr_manager'],
  
  manage_payroll: ['super_admin', 'admin', 'finance'],
  view_payroll: ['super_admin', 'admin', 'finance', 'hr_manager'],
  process_payroll: ['super_admin', 'admin', 'finance'],
  
  manage_performance: ['super_admin', 'admin', 'hr_manager'],
  view_performance: ['super_admin', 'admin', 'hr_manager', 'surveyor'],
  
  manage_expenses: ['super_admin', 'admin', 'finance', 'surveyor'],
  view_expenses: ['super_admin', 'admin', 'finance', 'hr_manager', 'surveyor'],
  approve_expenses: ['super_admin', 'admin', 'finance'],
  
  manage_grievances: ['super_admin', 'admin', 'hr_manager'],
  view_grievances: ['super_admin', 'admin', 'hr_manager', 'surveyor'],
  resolve_grievances: ['super_admin', 'admin', 'hr_manager'],
  
  // Admin Permissions
  manage_tenants: ['super_admin'],
  view_audit_logs: ['super_admin', 'admin'],
  manage_system_settings: ['super_admin'],
  view_system_stats: ['super_admin', 'admin'],
  
  // Notification Permissions
  send_notifications: ['super_admin', 'admin', 'surveyor', 'hr_manager'],
  view_notifications: ['super_admin', 'admin', 'surveyor', 'insurer', 'hr_manager', 'finance', 'viewer'],
  mark_notification_read: ['super_admin', 'admin', 'surveyor', 'insurer', 'hr_manager', 'finance', 'viewer'],
  
  // Dashboard Permissions
  view_dashboard: ['super_admin', 'admin', 'surveyor', 'insurer', 'hr_manager', 'finance', 'viewer'],
  view_surveyor_dashboard: ['super_admin', 'admin', 'surveyor'],
  view_hrms_dashboard: ['super_admin', 'admin', 'hr_manager', 'finance'],
  
  // Chatbot Permissions
  use_chatbot: ['super_admin', 'admin', 'surveyor', 'insurer', 'hr_manager', 'finance'],
  view_chat_history: ['super_admin', 'admin', 'surveyor'],
  
  // OCR Permissions
  use_ocr: ['super_admin', 'admin', 'surveyor'],
  view_ocr_results: ['super_admin', 'admin', 'surveyor', 'insurer'],
  
  // WebSocket/Realtime Permissions
  use_realtime: ['super_admin', 'admin', 'surveyor', 'insurer', 'hr_manager']
};

// Check if user has permission
export function hasPermission(role, permission) {
  const allowedRoles = PERMISSIONS[permission];
  if (!allowedRoles) {
    console.warn(`Permission "${permission}" not defined`);
    return false;
  }
  return allowedRoles.includes(role);
}

// Check if user can access a specific resource (by tenant)
export function canAccessResource(user, resourceTenantId) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role === 'admin' && user.tenantId === resourceTenantId) return true;
  if (user.role === 'surveyor' && user.tenantId === resourceTenantId) return true;
  return user.tenantId === resourceTenantId;
}

// Filter data by tenant
export function filterByTenant(data, user, tenantIdField = 'tenant_id') {
  if (!data || !Array.isArray(data)) return [];
  if (user.role === 'super_admin') return data;
  return data.filter(item => item[tenantIdField] === user.tenantId);
}

// Module visibility by role
export const MODULE_VISIBILITY = {
  super_admin: [
    'dashboard', 'surveyor', 'hrms', 'admin', 'tenants', 'audit_logs',
    'system_settings', 'insurance_companies', 'claims', 'reports',
    'ai_assistant', 'documents', 'pending_docs', 'ai_verification',
    'survey_reports', 'employees', 'attendance', 'leave_management',
    'payroll', 'performance', 'expenses', 'grievances', 'notifications',
    'chatbot', 'ocr', 'realtime'
  ],
  admin: [
    'dashboard', 'surveyor', 'hrms', 'claims', 'insurance_companies',
    'reports', 'ai_assistant', 'documents', 'pending_docs', 'ai_verification',
    'survey_reports', 'employees', 'attendance', 'leave_management',
    'performance', 'expenses', 'grievances', 'notifications', 'chatbot', 'ocr'
  ],
  surveyor: [
    'dashboard', 'claims', 'documents', 'pending_docs', 'ai_verification',
    'survey_reports', 'attendance', 'expenses', 'notifications', 'chatbot', 'ocr'
  ],
  insurer: [
    'dashboard', 'claims', 'documents', 'reports', 'notifications'
  ],
  hr_manager: [
    'dashboard', 'employees', 'attendance', 'leave_management', 'payroll',
    'performance', 'grievances', 'reports', 'notifications'
  ],
  finance: [
    'dashboard', 'payroll', 'expenses', 'settlements', 'reports', 'invoices'
  ],
  viewer: [
    'dashboard', 'claims', 'reports'
  ]
};

// Get modules visible to a role
export function getVisibleModules(role) {
  return MODULE_VISIBILITY[role] || MODULE_VISIBILITY.viewer;
}

// Get modules restricted from a role
export function getRestrictedModules(role) {
  const allModules = [
    'dashboard', 'surveyor', 'hrms', 'admin', 'tenants', 'audit_logs',
    'system_settings', 'insurance_companies', 'claims', 'reports',
    'ai_assistant', 'documents', 'pending_docs', 'ai_verification',
    'survey_reports', 'employees', 'attendance', 'leave_management',
    'payroll', 'performance', 'expenses', 'grievances', 'notifications',
    'chatbot', 'ocr', 'realtime', 'settlements', 'invoices', 'recruitment'
  ];
  const visible = getVisibleModules(role);
  return allModules.filter(module => !visible.includes(module));
}
