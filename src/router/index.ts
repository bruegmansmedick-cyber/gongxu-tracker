import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue'), meta: { tab: 'home' } },
    { path: '/record', name: 'record', component: () => import('@/views/RecordView.vue') },
    { path: '/records', name: 'records', component: () => import('@/views/RecordsView.vue'), meta: { tab: 'records' } },
    { path: '/dashboard', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { tab: 'dashboard' } },
    { path: '/manage', name: 'manage', component: () => import('@/views/ManageView.vue'), meta: { tab: 'manage' } },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { tab: 'settings' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ],
  scrollBehavior: () => ({ top: 0 })
})

export default router
