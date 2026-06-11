<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";

const emit = defineEmits<{ done: [] }>();
const password = ref("");
const error = ref(false);
const shaking = ref(false);
const inputRef = ref(null);
const CORRECT_PASSWORD = "123";

const avatars = ["/assets/jine/icon_cho.png", "/assets/jine/icon_ame.png"];
const avatar = avatars[Math.floor(Math.random() * avatars.length)];

const bgs = [
  "/assets/Fromtemd/tweet_selfie_cho_happy_end.png",
  "/assets/Fromtemd/tweet_selfie_cho_sleepy_001.png",
  "/assets/Fromtemd/tweet_selfie_cho_sorrow_001.png",
  "/assets/Fromtemd/tweet_selfie_cho_happy_001.png",
];
const bgImage = bgs[Math.floor(Math.random() * bgs.length)];

async function submit() {
  if (password.value === CORRECT_PASSWORD) { error.value = false; emit("done"); }
  else { error.value = true; shaking.value = true; password.value = ""; setTimeout(() => { shaking.value = false; }, 400); await nextTick(); inputRef.value?.focus(); }
}

onMounted(() => { setTimeout(() => inputRef.value?.focus(), 300); });
</script>

<template>
  <div class="login" :style="{ backgroundImage: 'url(' + bgImage + ')' }">
    <div class="overlay"></div>
    <div class="drag-bar" data-tauri-drag-region></div>
    <div class="card" :class="{ shake: shaking }">
      <div class="av-wrap"><img :src="avatar" alt="" class="av" /></div>
      <p class="welcome">ようこそ</p>
      <p class="uname">angelkawaii</p>
      <div class="pw-group">
        <input ref="inputRef" v-model="password" type="password" class="pw" :class="{ err: error }" placeholder="パスワードを入力" @keyup.enter="submit" autofocus />
      </div>
      <button class="btn" @click.stop="submit"><span class="btn-label">ログイン</span></button>
      <p v-if="error" class="err">パスワードが違います</p>
    </div>
    <div class="ft"><div class="ft-btn"><img src="/assets/Fromtemd/operation_close.png" alt="" class="ft-ic" /><span>シャットダウン</span></div></div>
  </div>
</template>

<style scoped>
.login {
  width:100%;height:100%;
  background-size:auto;background-repeat:repeat;
  background-position:0 0;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  cursor:default;position:relative;
  font-family:"zpix",sans-serif;
  image-rendering:pixelated;
}

.overlay {
  position:absolute;top:0;left:0;right:0;bottom:0;
  background:rgba(170,50,80,0.40);
  z-index:1;pointer-events:none;
}

.drag-bar {
  position:absolute;top:0;left:0;right:0;
  height:32px;z-index:20;cursor:move;
}

/* ---- 鍗＄墖 ---- */
.card {
  display:flex;flex-direction:column;
  align-items:center;gap:8px;
  z-index:2;
  padding:28px 44px 24px;
  background:rgba(20,5,20,0.55);
  border-radius:10px;
  border:1px solid rgba(255,255,255,0.1);
  backdrop-filter:blur(2px);
}
.card.shake{animation:sh .35s ease}
@keyframes sh{
  0%,100%{transform:translateX(0)}
  20%{transform:translateX(-8px)}
  40%{transform:translateX(8px)}
  60%{transform:translateX(-6px)}
  80%{transform:translateX(4px)}
}

/* 澶村儚 */
.av-wrap{display:flex;justify-content:center}
.av{
  width:80px;height:80px;
  image-rendering:pixelated;
  border:3px solid rgba(255,255,255,0.45);
  border-radius:10px;
  background:rgba(0,0,0,0.4);
  padding:6px;
  box-shadow:0 2px 12px rgba(0,0,0,0.4);
}

.welcome{
  color:rgba(255,255,255,0.6);font-size:11px;
  text-shadow:0 1px 3px rgba(0,0,0,0.6);
  margin-top:4px;
}
.uname{
  color:#fff;font-size:18px;font-weight:bold;
  text-shadow:0 2px 8px rgba(0,0,0,0.7);
  letter-spacing:2px;
}

/* 瀵嗙爜缁?*/
.pw-group{
  display:flex;align-items:center;
  background:rgba(0,0,0,0.4);
  border:1px solid rgba(255,255,255,0.15);
  border-radius:4px;
  padding:0 12px;
  margin-top:4px;
}

.pw{
  width:180px;padding:8px 4px;
  font-size:13px;font-family:"zpix",sans-serif;
  border:none;background:transparent;
  color:#fff;outline:none;text-align:center;
  letter-spacing:3px;
}
.pw::placeholder{color:rgba(255,255,255,0.3);letter-spacing:1px}
.pw.err{color:#f88}

/* 妫卞彴鎸夐挳 */
.btn{
  display:flex;align-items:center;justify-content:center;
  padding:6px 36px;margin-top:8px;
  background: rgba(180,80,120,0.85);
  border-top:    2px solid rgba(255,230,245,0.7);
  border-left:   2px solid rgba(255,210,235,0.6);
  border-right:  2px solid rgba(130,40,80,0.6);
  border-bottom: 2px solid rgba(90,20,50,0.7);
  cursor:pointer;
  color:#fff;font-family:"zpix",sans-serif;font-size:14px;
  transition:all .1s;
}
.btn:hover{
  background: rgba(200,100,140,0.9);
}
.btn:active{
  background: rgba(140,40,80,0.9);
  border-top:2px solid rgba(90,20,50,0.7);
  border-left:2px solid rgba(110,30,60,0.6);
  border-right:2px solid rgba(255,210,235,0.6);
  border-bottom:2px solid rgba(255,230,245,0.7);
}
.btn-label{letter-spacing:2px}

.err{
  color:#f88;font-size:12px;
  text-shadow:0 1px 3px rgba(0,0,0,0.7);
}

/* 搴曢儴 */
.ft{position:absolute;bottom:28px;z-index:2}
.ft-btn{
  display:flex;align-items:center;gap:6px;
  color:rgba(255,255,255,0.4);font-size:12px;
  cursor:pointer;padding:4px 10px;border-radius:3px;
}
.ft-btn:hover{color:rgba(255,255,255,0.75);background:rgba(255,255,255,0.06)}
.ft-ic{width:16px;height:16px;image-rendering:pixelated}
</style>