<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getBodyUrl } from "@/services/profile";

const AUTO_CLOSE_MS = 8000;

const closing = ref(false);
const visible = ref(true);

interface NotifData {
  body?: string;
  name?: string;
  avatar?: string;
}

const data = ref<NotifData>((window as any).__NOTIF_DATA__ || {});
const name = ref(data.value.name || "糖糖");
const body = ref(data.value.body || "");
const avatar = ref(data.value.avatar || getBodyUrl());

function close() {
  if (closing.value) return;
  closing.value = true;
  setTimeout(() => {
    visible.value = false;
    try { window.close(); } catch {}
  }, 300);
}

function handleClick() {
  invoke("focus_main").catch(() => {});
  close();
}

onMounted(() => {
  setTimeout(close, AUTO_CLOSE_MS);
});
</script>

<template>
  <div v-if="visible" class="notif-stage" @click="handleClick">
    <div class="notif-card" :class="{ 'notif-out': closing }">
      <div class="notif-close" @click.stop="close">&#x2715;</div>
      <img class="notif-avatar" :src="avatar" alt="avatar" />
      <div class="notif-body">
        <div class="notif-name">{{ name }}</div>
        <div class="notif-msg">{{ body }}</div>
      </div>
    </div>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: 100%; height: 100%;
  overflow: hidden;
  background: transparent !important;
  font-family: var(--font-notification);
  user-select: none;
}
</style>

<style scoped>
.notif-stage {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 24px;
  z-index: 1;
}
.notif-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  max-width: 380px;
  min-width: 280px;
  background: var(--color-notif-bg);
  backdrop-filter: blur(18px);
  border: 1px solid var(--color-notif-border);
  border-radius: 16px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.55);
  cursor: pointer;
  animation: notifIn 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
  transition: border-color 0.2s;
}
.notif-card:hover {
  border-color: var(--color-notif-hover-border);
  background: var(--color-notif-hover-bg);
}
.notif-out {
  animation: notifOut 0.3s ease-in forwards;
}
.notif-close {
  position: absolute;
  top: 6px;
  right: 10px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: rgba(240, 160, 192, 0.35);
  border-radius: 50%;
  transition: all 0.2s;
}
.notif-close:hover {
  color: #fff;
  background: var(--color-notif-close-hover-bg);
}
.notif-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 2px solid var(--color-notif-hover-border);
  object-fit: cover;
  flex-shrink: 0;
}
.notif-body {
  flex: 1;
  min-width: 0;
}
.notif-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-pink);
  margin-bottom: 4px;
}
.notif-msg {
  font-size: 13px;
  color: #eeddee;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
@keyframes notifIn {
  from { transform: translateX(48px); opacity: 0; }
  to   { transform: translateX(0);    opacity: 1; }
}
@keyframes notifOut {
  from { transform: translateX(0);    opacity: 1; }
  to   { transform: translateX(48px); opacity: 0; }
}
</style>