<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getUiUrl } from "@/services/profile";

const u = (p: string) => getUiUrl(p);

interface DesktopIcon { id: string; label: string; src: string; }

const icons: DesktopIcon[] = [
  { id:"egosearch", label:"EgoSearcher", src: u("Fromtemd/icon_desktop_egosearch.png") },
  { id:"internet",  label:"Internet",    src: u("Fromtemd/icon_desktop_internet.png") },
  { id:"folder1",   label:"ドキュメント", src: u("Fromtemd/icon_desktop_folder_open1.png") },
  { id:"folder2",   label:"ピクチャ",     src: u("Fromtemd/icon_desktop_folder_open2.png") },
  { id:"twitter",   label:"Twitter",     src: u("Fromtemd/icon_desktop_twitter.png") },
  { id:"youtube",   label:"YouTube",     src: u("Fromtemd/icon_desktop_youtube2.png") },
  { id:"movie",     label:"Movies",      src: u("Fromtemd/icon_desktop_movie.png") },
  { id:"text",      label:"メモ",         src: u("Fromtemd/icon_desktop_text.png") },
  { id:"zip",       label:"Archive",     src: u("Fromtemd/icon_desktop_folder_zip.png") },
  { id:"jine",      label:"Jine",        src: u("Fromtemd/icon_desktop_jine2.png") },
  { id:"trash",     label:"ゴミ箱",       src: u("Fromtemd/icon_trash_can.png") },
];

const avatars = [u("jine/icon_cho.png"), u("jine/icon_ame.png")];
const userAvatar = avatars[Math.floor(Math.random() * avatars.length)];
const selectedId = ref<string|null>(null);
const showStartMenu = ref(false);
const clock = ref("");

function selectIcon(id:string){selectedId.value=id}
function dblClickIcon(_id:string){}

let ct:ReturnType<typeof setInterval>|null=null;
function tick(){const n=new Date();clock.value=String(n.getHours()).padStart(2,"0")+":"+String(n.getMinutes()).padStart(2,"0")}
onMounted(()=>{tick();ct=setInterval(tick,15000)});
onUnmounted(()=>{if(ct)clearInterval(ct)});

const taskbarApps=[
  {src: u("Fromtemd/icon_taskbar_jine.png"),alt:"Jine"},
  {src: u("Fromtemd/icon_taskbar_poketter.png"),alt:"Poketter"},
  {src: u("Fromtemd/icon_taskbar_taskmanager.png"),alt:"TaskMgr"},
];
const trayIcons=[
  {src: u("Fromtemd/icon_status_yami.png"),alt:"yami"},
  {src: u("Fromtemd/icon_status_follower.png"),alt:"follower"},
  {src: u("Fromtemd/icon_status_love.png"),alt:"love"},
  {src: u("Fromtemd/icon_status_stress.png"),alt:"stress"},
];
const startMenuItems=[
  {src: u("Fromtemd/icon_desktop_egosearch.png"),label:"EgoSearcher"},
  {src: u("Fromtemd/icon_desktop_internet.png"), label:"Internet"},
  {src: u("Fromtemd/icon_desktop_movie.png"),    label:"Movies"},
  {src: u("Fromtemd/icon_desktop_twitter.png"),  label:"Twitter"},
  {src: u("Fromtemd/icon_desktop_youtube2.png"), label:"YouTube"},
  {src: u("Fromtemd/icon_desktop_jine2.png"),    label:"Jine"},
];

function toggleStartMenu(){showStartMenu.value=!showStartMenu.value}
function closeWindow(){invoke("close_windows_sim").catch(()=>{})}
</script>

<template>
  <div class="desk" @click="selectedId=null;showStartMenu=false">
    <div class="drag-top" data-tauri-drag-region></div>
    <img class="wp" :src="u('Fromtemd/FHDbg.png')" alt="" />
    <div class="icons" @click.stop>
      <div v-for="icon in icons" :key="icon.id" class="di" :class="{sel:selectedId===icon.id}" @click.stop="selectIcon(icon.id)" @dblclick.stop="dblClickIcon(icon.id)">
        <img :src="icon.src" :alt="icon.label" class="di-img" />
        <span class="di-lbl">{{ icon.label }}</span>
      </div>
    </div>
    <Transition name="mu">
      <div v-if="showStartMenu" class="sm" @click.stop>
        <div class="sm-hd"><img :src="userAvatar" alt="" class="sm-av" /><span class="sm-usr">User</span></div>
        <div class="sm-bd"><div v-for="(item,i) in startMenuItems" :key="i" class="sm-row"><img :src="item.src" alt="" class="sm-ic" /><span>{{ item.label }}</span></div></div>
        <div class="sm-ft" @click.stop="closeWindow"><img :src="u('Fromtemd/operation_close.png')" alt="" class="sm-fi" /><span>シャットダウン</span></div>
      </div>
    </Transition>
    <div class="tb">
      <div class="tb-l">
        <button class="tb-st" @click.stop="toggleStartMenu"><img :src="u('Fromtemd/button_start.png')" alt="Start" /></button>
        <span class="tb-sp"></span>
        <button v-for="(app,i) in taskbarApps" :key="i" class="tb-ap"><img :src="app.src" :alt="app.alt" /></button>
      </div>
      <div class="tb-r">
        <img v-for="(icon,i) in trayIcons" :key="i" :src="icon.src" :alt="icon.alt" class="tb-ti" />
        <span class="tb-ar">▲</span>
        <span class="tb-clk">{{ clock }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.desk { width:100%;height:100%;position:relative;overflow:hidden;user-select:none;font-family:"zpix",sans-serif; }
.drag-top{position:absolute;top:0;left:0;right:0;height:24px;z-index:100;cursor:move}
.wp{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0;image-rendering:pixelated}
.icons{position:absolute;top:28px;left:8px;bottom:48px;display:flex;flex-direction:column;flex-wrap:wrap;align-content:flex-start;gap:2px;z-index:2}
.di{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;width:76px;padding:4px 4px 2px;cursor:pointer;border-radius:3px;border:2px solid transparent}
.di:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18)}
.di.sel{background:var(--color-accent-light, rgba(200,100,220,0.35));border-color:var(--color-accent-light, rgba(220,180,240,0.5))}
.di-img{width:36px;height:36px;image-rendering:pixelated;object-fit:contain;pointer-events:none}
.di-lbl{color:#fff;font-size:11px;line-height:1.3;text-shadow:0 1px 3px rgba(0,0,0,0.9);text-align:center;word-break:break-all;max-width:68px;pointer-events:none;margin-top:1px}
.sm{position:absolute;bottom:40px;left:0;width:230px;background:var(--color-winsim-taskbar-bg, #fff);border-top:3px solid var(--color-winsim-accent, #9a60c0);z-index:100;box-shadow:2px -2px 16px rgba(0,0,0,0.3);border-radius:0 6px 0 0}
.sm-hd{display:flex;align-items:center;gap:10px;padding:10px 14px;background:linear-gradient(180deg,#f4e8fc,#e4ccf0);color:#5a2a7a;font-size:13px;font-weight:bold}
.sm-av{width:34px;height:34px;image-rendering:pixelated;border:2px solid #d0b0e0;border-radius:3px}
.sm-bd{padding:2px 0}
.sm-row{display:flex;align-items:center;gap:10px;padding:6px 18px;cursor:pointer;font-size:12px;color:#333}
.sm-row:hover{background:#f0e0f8}
.sm-ic{width:22px;height:22px;image-rendering:pixelated}
.sm-ft{display:flex;align-items:center;gap:8px;padding:7px 18px;border-top:1px solid #e0d0ec;color:#555;font-size:12px;cursor:pointer}
.sm-ft:hover{background:#f4e8f8}
.sm-fi{width:18px;height:18px;image-rendering:pixelated}
.mu-enter-active{transition:all .18s ease-out}
.mu-leave-active{transition:all .12s ease-in}
.mu-enter-from,.mu-leave-to{opacity:0;transform:translateY(8px)}
.tb { position:absolute;bottom:0;left:0;right:0;height:40px;
  background: linear-gradient(180deg,
    rgba(255,255,255,0.5) 0px, #f7e1fb 4px, #e8c8f0 12px,
    #d4a8e0 26px, #c080d0 36px, #a860c0 40px);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 3px;z-index:50;
}
.tb-l{display:flex;align-items:center;gap:0;height:100%}
.tb-st{ background:none;border:none;cursor:pointer;padding:3px 8px;height:100%;display:flex;align-items:center;
  border-top: 1px solid rgba(255,255,255,0.4);border-radius: 2px; }
.tb-st:hover{background:rgba(255,255,255,0.35)}
.tb-st:active{ border-top: 1px solid rgba(0,0,0,0.3);background:rgba(0,0,0,0.08); }
.tb-st img{height:26px;image-rendering:pixelated}
.tb-sp{width:1px;height:22px;background:rgba(0,0,0,0.2);margin:0 3px;box-shadow:1px 0 0 rgba(255,255,255,0.3)}
.tb-ap{ background:none;border:none;cursor:pointer;padding:3px 6px;height:100%;display:flex;align-items:center; }
.tb-ap:hover{background:rgba(255,255,255,0.25)}
.tb-ap img{height:22px;image-rendering:pixelated}
.tb-r{display:flex;align-items:center;gap:6px;padding-right:6px}
.tb-ti{height:16px;image-rendering:pixelated}
.tb-ar{font-size:8px;color:rgba(0,0,0,0.4)}
.tb-clk{font-size:10px;color:#2a0a2a;min-width:38px;text-align:right}
</style>
