#!/bin/zsh
cd "${0:A:h}"
python3 native/install.py
printf '\n按回车关闭窗口…'
read
