<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { state } from '@/store'

const route = useRoute()
const showTabbar = computed(() => Boolean(route.meta.tab))

const themeVars = {
  primaryColor: '#1f6feb',
  borderColor: '#e8eaee',
  background2: '#f5f6f8',
  cellBackground: '#ffffff',
  navBarBackground: '#ffffff',
  navBarTitleFontSize: '17px',
  tabbarHeight: '52px',
  tabbarItemFontSize: '11px'
}
</script>

<template>
  <van-config-provider :theme-vars="themeVars">
    <div class="app-shell">
      <router-view />

      <div v-if="state.sync.pending && state.sync.configured" class="sync-ribbon" @click="$router.push('/settings')">
        <van-icon name="cloud-o" />
        有数据待同步
      </div>

      <van-tabbar v-if="showTabbar" route fixed placeholder safe-area-inset-bottom>
        <van-tabbar-item replace to="/" icon="wap-home-o">今日</van-tabbar-item>
        <van-tabbar-item replace to="/records" icon="orders-o">明细</van-tabbar-item>
        <van-tabbar-item replace to="/dashboard" icon="bar-chart-o">看板</van-tabbar-item>
        <van-tabbar-item replace to="/manage" icon="apps-o">工程</van-tabbar-item>
        <van-tabbar-item replace to="/settings" icon="setting-o">设置</van-tabbar-item>
      </van-tabbar>
    </div>
  </van-config-provider>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}

.sync-ribbon {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.94);
  color: #fff;
  font-size: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
}
</style>
