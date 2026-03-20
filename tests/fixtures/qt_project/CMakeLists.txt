cmake_minimum_required(VERSION 3.14)
project(QtTest)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)

find_package(Qt5 COMPONENTS Core Widgets REQUIRED)

add_executable(QtTest main.cpp mywidget.cpp mywidget.h)
target_link_libraries(QtTest Qt5::Core Qt5::Widgets)
