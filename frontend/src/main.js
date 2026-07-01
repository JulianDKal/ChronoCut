import { createApp } from 'vue'
import App from './App.vue'
import './theme.css'
import '@fontsource/inter/800.css'   // used by the "ChronoCut" title in the mobile view

// Add this to remove default margins
const style = document.createElement('style')
style.textContent = `
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  
  body {
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
  
  html, body, #app {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
  }
`
document.head.appendChild(style)

createApp(App).mount('#app')